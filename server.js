require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const mercadopago = require('mercadopago');

const User = require('./models/User');
const Transaction = require('./models/Transaction');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

const REQUIRED_ENV = ['MERCADO_PAGO_ACCESS_TOKEN', 'SESSION_SECRET', 'MONGODB_URI'];

const missingEnv = REQUIRED_ENV.filter((k) => {
  if (k === 'MONGODB_URI') {
    return !MONGODB_URI;
  }
  return !process.env[k];
});

if (missingEnv.length > 0) {
  console.error('Variáveis de ambiente faltando:', missingEnv.join(', '));
  process.exit(1);
}

mercadopago.configure({
  access_token: process.env.MERCADO_PAGO_ACCESS_TOKEN
});

function sanitizeUser(user) {
  return {
    id: String(user._id),
    username: user.username,
    fullName: user.fullName,
    email: user.email,
    phone: user.phone,
    documentNumber: user.documentNumber,
    birthDate: user.birthDate,
    createdAt: user.createdAt
  };
}

function mapMpStatus(status) {
  return status || 'pending';
}

function buildWebhookUrl() {
  const base = String(process.env.BASE_URL || '').trim();
  const token = String(process.env.MERCADO_PAGO_WEBHOOK_TOKEN || '').trim();

  if (!base || !token || base.includes('SEU-ENDERECO-PUBLICO')) {
    return null;
  }

  try {
    const url = new URL(base);
    if (url.protocol !== 'https:') {
      return null;
    }
    return `${url.origin}/webhook/mercadopago?token=${encodeURIComponent(token)}`;
  } catch (err) {
    return null;
  }
}

function serializeTx(tx) {
  return {
    ...tx,
    userId: String(tx.userId),
    createdAt: tx.createdAt instanceof Date ? tx.createdAt.toISOString() : tx.createdAt,
    updatedAt: tx.updatedAt instanceof Date ? tx.updatedAt.toISOString() : tx.updatedAt,
    lastCheckedAt: tx.lastCheckedAt instanceof Date ? tx.lastCheckedAt.toISOString() : tx.lastCheckedAt
  };
}

async function refreshPaymentStatus(localPaymentId) {
  const tx = await Transaction.findOne({ localPaymentId });
  if (!tx || !tx.mpPaymentId) {
    return tx;
  }

  const mpPayment = await mercadopago.payment.findById(tx.mpPaymentId);

  tx.status = mapMpStatus(mpPayment?.body?.status);
  tx.statusDetail = mpPayment?.body?.status_detail || tx.statusDetail;
  tx.lastCheckedAt = new Date();
  tx.updatedAt = new Date();

  await tx.save();
  return tx;
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'script-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:']
      }
    }
  })
);

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 150,
    standardHeaders: true,
    legacyHeaders: false
  })
);

app.use(
  session({
    name: 'mp.sid',
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    store: MongoStore.create({
      mongoUrl: MONGODB_URI,
      ttl: 60 * 60 * 24 * 30,
      autoRemove: 'native'
    }),
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 24 * 30
    }
  })
);

app.use((req, res, next) => {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;
  res.locals.currentUser = req.session.user || null;
  next();
});

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/');
  }
  return next();
}

function requireCsrf(req, res, next) {
  const token = req.body?.csrfToken || req.get('x-csrf-token');
  if (!token || token !== req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    if (req.session.user) {
      return res.redirect('/dashboard?error=csrf');
    }
    return res.redirect('/?error=csrf');
  }
  return next();
}

app.get('/', (req, res) => {
  if (req.session.user) {
    return res.redirect('/dashboard');
  }

  const error = req.query.error === 'csrf'
    ? 'Sessão expirada ou formulário antigo. Atualize a página e tente novamente.'
    : null;

  return res.render('index', { error, message: null });
});

app.post('/register', requireCsrf, async (req, res) => {
  const {
    username,
    fullName,
    email,
    phone,
    documentNumber,
    birthDate,
    password
  } = req.body;

  if (
    !username ||
    !fullName ||
    !email ||
    !phone ||
    !documentNumber ||
    !birthDate ||
    !password ||
    String(password).length < 8
  ) {
    return res.status(400).render('index', {
      error: 'Preencha todos os campos. Senha precisa ter ao menos 8 caracteres.',
      message: null
    });
  }

  const normalizedEmail = String(email).trim().toLowerCase();

  const existing = await User.findOne({ email: normalizedEmail }).lean();
  if (existing) {
    return res.status(409).render('index', {
      error: 'E-mail já cadastrado.',
      message: null
    });
  }

  const passwordHash = await bcrypt.hash(String(password), 12);

  const user = await User.create({
    username: String(username).trim(),
    fullName: String(fullName).trim(),
    email: normalizedEmail,
    phone: String(phone).trim(),
    documentNumber: String(documentNumber).replace(/\D/g, ''),
    birthDate: String(birthDate),
    passwordHash
  });

  req.session.user = sanitizeUser(user);
  return res.redirect('/dashboard');
});

app.post('/login', requireCsrf, async (req, res) => {
  const { email, password } = req.body;
  const normalizedEmail = String(email || '').trim().toLowerCase();

  const user = await User.findOne({ email: normalizedEmail });
  if (!user) {
    return res.status(401).render('index', {
      error: 'Credenciais inválidas.',
      message: null
    });
  }

  const ok = await bcrypt.compare(String(password || ''), user.passwordHash);
  if (!ok) {
    return res.status(401).render('index', {
      error: 'Credenciais inválidas.',
      message: null
    });
  }

  req.session.user = sanitizeUser(user);
  return res.redirect('/dashboard');
});

app.post('/logout', requireAuth, requireCsrf, (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

app.get('/dashboard', requireAuth, async (req, res) => {
  const transactions = await Transaction.find({ userId: req.session.user.id })
    .sort({ createdAt: -1 })
    .lean();

  const error = req.query.error === 'csrf'
    ? 'Sessão expirada ou formulário antigo. Tente novamente.'
    : null;

  return res.render('dashboard', {
    error,
    message: null,
    transactions: transactions.map(serializeTx),
    currentPayment: null
  });
});

app.post('/payments/create', requireAuth, requireCsrf, async (req, res) => {
  const baseAmount = 1.0;
  const lunchAddon = req.body.withLunch ? 0.5 : 0;
  const amount = Number((baseAmount + lunchAddon).toFixed(2));

  const user = await User.findById(req.session.user.id).lean();
  if (!user) {
    req.session.destroy(() => {});
    return res.redirect('/');
  }

  const localPaymentId = crypto.randomUUID();

  try {
    const webhookUrl = buildWebhookUrl();
    const paymentData = {
      transaction_amount: amount,
      payment_method_id: 'pix',
      description: req.body.withLunch
        ? `Ingresso + almoço (R$ ${amount.toFixed(2)})`
        : `Ingresso (R$ ${amount.toFixed(2)})`,
      external_reference: localPaymentId,
      payer: {
        email: user.email,
        first_name: user.username
      }
    };

    if (webhookUrl) {
      paymentData.notification_url = webhookUrl;
    }

    const payment = await mercadopago.payment.create(paymentData);
    const txData = payment.body?.point_of_interaction?.transaction_data || {};

    await Transaction.create({
      localPaymentId,
      userId: user._id,
      amount,
      baseAmount,
      lunchAddon,
      withLunch: Boolean(req.body.withLunch),
      status: mapMpStatus(payment.body?.status),
      statusDetail: payment.body?.status_detail || null,
      mpPaymentId: payment.body?.id ? String(payment.body.id) : null,
      externalReference: localPaymentId,
      qrCode: txData.qr_code || null,
      qrCodeBase64: txData.qr_code_base64 || null,
      ticketUrl: txData.ticket_url || null,
      lastCheckedAt: null
    });

    return res.redirect(`/payments/${localPaymentId}`);
  } catch (error) {
    const apiMessage =
      error?.cause?.[0]?.description ||
      error?.message ||
      'Erro desconhecido no provedor de pagamento.';

    console.error('Erro ao criar PIX:', apiMessage, error?.cause || '');

    const transactions = await Transaction.find({ userId: req.session.user.id })
      .sort({ createdAt: -1 })
      .lean();

    return res.status(500).render('dashboard', {
      error: `Falha ao criar cobrança PIX: ${apiMessage}`,
      message: null,
      transactions: transactions.map(serializeTx),
      currentPayment: null
    });
  }
});

app.get('/payments/:localPaymentId', requireAuth, async (req, res) => {
  const tx = await Transaction.findOne({
    localPaymentId: req.params.localPaymentId,
    userId: req.session.user.id
  });

  if (!tx) {
    return res.status(404).send('Pagamento não encontrado.');
  }

  if (tx.status === 'pending') {
    try {
      await refreshPaymentStatus(tx.localPaymentId);
    } catch (err) {
      // segue com último status em caso de erro temporário
    }
  }

  const freshTx = await Transaction.findOne({
    localPaymentId: req.params.localPaymentId,
    userId: req.session.user.id
  }).lean();

  const transactions = await Transaction.find({ userId: req.session.user.id })
    .sort({ createdAt: -1 })
    .lean();

  return res.render('dashboard', {
    error: null,
    message: null,
    transactions: transactions.map(serializeTx),
    currentPayment: freshTx ? serializeTx(freshTx) : null
  });
});

app.get('/payments/:localPaymentId/status', requireAuth, async (req, res) => {
  try {
    const tx = await Transaction.findOne({
      localPaymentId: req.params.localPaymentId,
      userId: req.session.user.id
    });

    if (!tx) {
      return res.status(404).json({ error: 'Pagamento não encontrado.' });
    }

    if (tx.status === 'pending') {
      await refreshPaymentStatus(tx.localPaymentId);
    }

    const latest = await Transaction.findOne({
      localPaymentId: req.params.localPaymentId,
      userId: req.session.user.id
    }).lean();

    return res.json({
      localPaymentId: latest.localPaymentId,
      status: latest.status,
      statusDetail: latest.statusDetail,
      updatedAt: latest.updatedAt
    });
  } catch (error) {
    return res.status(500).json({ error: 'Erro ao consultar status.' });
  }
});

app.post('/webhook/mercadopago', async (req, res) => {
  if (!process.env.MERCADO_PAGO_WEBHOOK_TOKEN) {
    return res.status(503).send('webhook-not-configured');
  }

  if (req.query.token !== process.env.MERCADO_PAGO_WEBHOOK_TOKEN) {
    return res.status(401).send('unauthorized');
  }

  try {
    const topic = req.query.topic || req.body?.type;
    const paymentId = req.query.id || req.body?.data?.id;

    if (!paymentId || (topic !== 'payment' && topic !== 'payment.updated')) {
      return res.status(200).send('ignored');
    }

    const payment = await mercadopago.payment.findById(paymentId);
    const mpPayment = payment.body;
    const externalReference = mpPayment?.external_reference;

    if (!externalReference) {
      return res.status(200).send('ok');
    }

    const tx = await Transaction.findOne({ localPaymentId: externalReference });
    if (!tx) {
      return res.status(200).send('ok');
    }

    tx.status = mapMpStatus(mpPayment?.status);
    tx.statusDetail = mpPayment?.status_detail || tx.statusDetail;
    tx.mpPaymentId = mpPayment?.id ? String(mpPayment.id) : tx.mpPaymentId;
    tx.lastCheckedAt = new Date();
    tx.updatedAt = new Date();

    await tx.save();

    return res.status(200).send('ok');
  } catch (error) {
    return res.status(200).send('ok');
  }
});

async function startServer() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('MongoDB conectado com sucesso.');

    app.listen(PORT, () => {
      console.log(`Servidor online em http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Falha ao conectar no MongoDB:', error.message);
    process.exit(1);
  }
}

startServer();
