require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const connectMongo = require('connect-mongo');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const mercadopago = require('mercadopago');

const Transaction = require('./models/Transaction');
const Coupon = require('./models/Coupon');
const AdminSetting = require('./models/AdminSetting');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
const MongoStore = connectMongo.default || connectMongo;

const BASE_TICKET_PRICE = 1;
const LUNCH_ADDON_PRICE = 0.5;

const REQUIRED_ENV = ['MERCADO_PAGO_ACCESS_TOKEN', 'SESSION_SECRET', 'ADMIN_PASSWORD'];
const missingEnv = REQUIRED_ENV.filter((k) => !process.env[k]);
if (!MONGODB_URI) {
  missingEnv.push('MONGODB_URI');
}

if (missingEnv.length > 0) {
  console.error('Variáveis de ambiente faltando:', missingEnv.join(', '));
  process.exit(1);
}

mercadopago.configure({
  access_token: process.env.MERCADO_PAGO_ACCESS_TOKEN
});

let adminConfigCache = null;

function mapMpStatus(status) {
  return status || 'pending';
}

function createMongoSessionStore() {
  const options = {
    mongoUrl: MONGODB_URI,
    ttl: 60 * 60 * 24 * 30,
    autoRemove: 'native'
  };

  if (typeof MongoStore.create === 'function') {
    return MongoStore.create(options);
  }

  return new MongoStore(options);
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

function parseQty(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    return 0;
  }
  return n;
}

function calcAmounts(quantityWithoutLunch, quantityWithLunch, discountValue) {
  const subtotal =
    quantityWithoutLunch * BASE_TICKET_PRICE +
    quantityWithLunch * (BASE_TICKET_PRICE + LUNCH_ADDON_PRICE);

  const maxDiscount = Math.max(0, subtotal - 0.01);
  const discountAmount = Math.min(Math.max(discountValue || 0, 0), maxDiscount);
  const total = Number((subtotal - discountAmount).toFixed(2));

  return {
    subtotal: Number(subtotal.toFixed(2)),
    discountAmount: Number(discountAmount.toFixed(2)),
    total
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
  await tx.save();

  return tx;
}

async function ensureAdminConfig() {
  const envPassword = String(process.env.ADMIN_PASSWORD || '');
  const existing = await AdminSetting.findOne({ key: 'main' });

  if (!existing) {
    const passwordHash = await bcrypt.hash(envPassword, 12);
    const adminPath = `painel-${crypto.randomBytes(12).toString('hex')}`;

    const created = await AdminSetting.create({
      key: 'main',
      passwordHash,
      adminPath
    });

    adminConfigCache = created;
    return created;
  }

  const matches = await bcrypt.compare(envPassword, existing.passwordHash);
  if (!matches) {
    existing.passwordHash = await bcrypt.hash(envPassword, 12);
    await existing.save();
  }

  adminConfigCache = existing;
  return existing;
}

function getAdminBasePath() {
  return `/admin/${adminConfigCache.adminPath}`;
}

function requireCsrf(req, res, next) {
  const token = req.body?.csrfToken || req.get('x-csrf-token');
  if (!token || token !== req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    return res.redirect('/?error=csrf');
  }
  return next();
}

function requireAdminSlug(req, res, next) {
  if (!adminConfigCache || req.params.slug !== adminConfigCache.adminPath) {
    return res.status(404).send('Página não encontrada.');
  }
  return next();
}

function requireAdminAuth(req, res, next) {
  if (req.session?.adminAuthenticated === true) {
    return next();
  }
  return res.redirect(`/admin/${req.params.slug}/login`);
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
    max: 200,
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
    store: createMongoSessionStore(),
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
  next();
});

app.get('/', (req, res) => {
  const error = req.query.error === 'csrf'
    ? 'Sessão expirada ou formulário antigo. Atualize a página e tente novamente.'
    : null;

  return res.render('index', {
    error,
    message: null,
    prices: {
      base: BASE_TICKET_PRICE,
      lunch: LUNCH_ADDON_PRICE
    }
  });
});

app.post('/checkout', requireCsrf, async (req, res) => {
  const buyerName = String(req.body.buyerName || '').trim();
  const buyerEmail = String(req.body.buyerEmail || '').trim().toLowerCase();
  const buyerPhone = String(req.body.buyerPhone || '').trim();
  const quantityWithoutLunch = parseQty(req.body.quantityWithoutLunch);
  const quantityWithLunch = parseQty(req.body.quantityWithLunch);
  const couponInput = String(req.body.couponCode || '').trim().toLowerCase();

  if (!buyerName || !buyerEmail) {
    return res.status(400).render('index', {
      error: 'Informe nome e e-mail para a inscrição.',
      message: null,
      prices: { base: BASE_TICKET_PRICE, lunch: LUNCH_ADDON_PRICE }
    });
  }

  if (quantityWithoutLunch + quantityWithLunch <= 0) {
    return res.status(400).render('index', {
      error: 'Informe ao menos 1 ingresso.',
      message: null,
      prices: { base: BASE_TICKET_PRICE, lunch: LUNCH_ADDON_PRICE }
    });
  }

  let coupon = null;
  if (couponInput) {
    coupon = await Coupon.findOne({ code: couponInput, isUsed: false });
    if (!coupon) {
      return res.status(400).render('index', {
        error: 'Cupom inválido ou já utilizado.',
        message: null,
        prices: { base: BASE_TICKET_PRICE, lunch: LUNCH_ADDON_PRICE }
      });
    }
  }

  const amounts = calcAmounts(quantityWithoutLunch, quantityWithLunch, coupon?.discountAmount || 0);
  const localPaymentId = crypto.randomUUID();

  try {
    const webhookUrl = buildWebhookUrl();

    const paymentData = {
      transaction_amount: amounts.total,
      payment_method_id: 'pix',
      description: `Ingressos: ${quantityWithoutLunch + quantityWithLunch} (${quantityWithLunch} c/ almoço)`,
      external_reference: localPaymentId,
      payer: {
        email: buyerEmail,
        first_name: buyerName
      }
    };

    if (webhookUrl) {
      paymentData.notification_url = webhookUrl;
    }

    const payment = await mercadopago.payment.create(paymentData);
    const txData = payment.body?.point_of_interaction?.transaction_data || {};

    await Transaction.create({
      localPaymentId,
      buyerName,
      buyerEmail,
      buyerPhone,
      quantityWithoutLunch,
      quantityWithLunch,
      baseTicketPrice: BASE_TICKET_PRICE,
      lunchAddonPrice: LUNCH_ADDON_PRICE,
      subtotalAmount: amounts.subtotal,
      discountAmount: amounts.discountAmount,
      couponCode: coupon?.code || null,
      amount: amounts.total,
      status: mapMpStatus(payment.body?.status),
      statusDetail: payment.body?.status_detail || null,
      mpPaymentId: payment.body?.id ? String(payment.body.id) : null,
      externalReference: localPaymentId,
      qrCode: txData.qr_code || null,
      qrCodeBase64: txData.qr_code_base64 || null,
      ticketUrl: txData.ticket_url || null,
      lastCheckedAt: null
    });

    if (coupon) {
      coupon.isUsed = true;
      coupon.usedAt = new Date();
      coupon.usedByPaymentId = localPaymentId;
      await coupon.save();
    }

    return res.redirect(`/payment/${localPaymentId}`);
  } catch (error) {
    const apiMessage =
      error?.cause?.[0]?.description ||
      error?.message ||
      'Erro desconhecido no provedor de pagamento.';

    console.error('Erro ao criar PIX:', apiMessage, error?.cause || '');

    return res.status(500).render('index', {
      error: `Falha ao criar cobrança PIX: ${apiMessage}`,
      message: null,
      prices: { base: BASE_TICKET_PRICE, lunch: LUNCH_ADDON_PRICE }
    });
  }
});

app.get('/payment/:localPaymentId', async (req, res) => {
  const tx = await Transaction.findOne({ localPaymentId: req.params.localPaymentId }).lean();

  if (!tx) {
    return res.status(404).send('Pagamento não encontrado.');
  }

  if (tx.status === 'pending') {
    try {
      await refreshPaymentStatus(tx.localPaymentId);
    } catch (err) {
      // mantém último status
    }
  }

  const freshTx = await Transaction.findOne({ localPaymentId: req.params.localPaymentId }).lean();

  return res.render('dashboard', {
    currentPayment: freshTx,
    prices: {
      base: BASE_TICKET_PRICE,
      lunch: LUNCH_ADDON_PRICE
    }
  });
});

app.get('/payments/:localPaymentId/status', async (req, res) => {
  try {
    const tx = await Transaction.findOne({ localPaymentId: req.params.localPaymentId });

    if (!tx) {
      return res.status(404).json({ error: 'Pagamento não encontrado.' });
    }

    if (tx.status === 'pending') {
      await refreshPaymentStatus(tx.localPaymentId);
    }

    const latest = await Transaction.findOne({ localPaymentId: req.params.localPaymentId }).lean();

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
    await tx.save();

    return res.status(200).send('ok');
  } catch (error) {
    return res.status(200).send('ok');
  }
});

app.get('/admin/:slug/login', requireAdminSlug, (req, res) => {
  return res.render('admin-login', {
    error: null,
    adminPath: req.params.slug
  });
});

app.post('/admin/:slug/login', requireAdminSlug, requireCsrf, async (req, res) => {
  const password = String(req.body.password || '');
  const ok = await bcrypt.compare(password, adminConfigCache.passwordHash);

  if (!ok) {
    return res.status(401).render('admin-login', {
      error: 'Senha inválida.',
      adminPath: req.params.slug
    });
  }

  req.session.adminAuthenticated = true;
  return res.redirect(`/admin/${req.params.slug}/dashboard`);
});

app.post('/admin/:slug/logout', requireAdminSlug, requireAdminAuth, requireCsrf, (req, res) => {
  req.session.adminAuthenticated = false;
  return res.redirect(`/admin/${req.params.slug}/login`);
});

app.get('/admin/:slug/dashboard', requireAdminSlug, requireAdminAuth, async (req, res) => {
  const transactions = await Transaction.find({}).sort({ createdAt: -1 }).lean();
  const coupons = await Coupon.find({}).sort({ createdAt: -1 }).lean();

  return res.render('admin-dashboard', {
    adminPath: req.params.slug,
    transactions,
    coupons,
    error: null,
    message: null
  });
});

app.post('/admin/:slug/coupons', requireAdminSlug, requireAdminAuth, requireCsrf, async (req, res) => {
  const code = String(req.body.code || '').trim().toLowerCase();
  const discountAmount = Number(req.body.discountAmount);

  if (!code || !Number.isFinite(discountAmount) || discountAmount <= 0) {
    const transactions = await Transaction.find({}).sort({ createdAt: -1 }).lean();
    const coupons = await Coupon.find({}).sort({ createdAt: -1 }).lean();
    return res.status(400).render('admin-dashboard', {
      adminPath: req.params.slug,
      transactions,
      coupons,
      error: 'Cupom inválido. Informe código e desconto maior que 0.',
      message: null
    });
  }

  const existing = await Coupon.findOne({ code }).lean();
  if (existing) {
    const transactions = await Transaction.find({}).sort({ createdAt: -1 }).lean();
    const coupons = await Coupon.find({}).sort({ createdAt: -1 }).lean();
    return res.status(409).render('admin-dashboard', {
      adminPath: req.params.slug,
      transactions,
      coupons,
      error: 'Esse cupom já existe.',
      message: null
    });
  }

  await Coupon.create({
    code,
    discountAmount,
    createdBy: 'admin'
  });

  return res.redirect(`/admin/${req.params.slug}/dashboard`);
});

async function startServer() {
  try {
    await mongoose.connect(MONGODB_URI);
    await ensureAdminConfig();

    console.log('MongoDB conectado com sucesso.');
    console.log(`Painel admin: ${getAdminBasePath()}/login`);

    app.listen(PORT, () => {
      console.log(`Servidor online em http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Falha ao iniciar servidor:', error.message);
    process.exit(1);
  }
}

startServer();
