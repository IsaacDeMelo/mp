require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { sendConfirmationEmail, sendLeaderConfirmationEmail } = require("./mailer");
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

function getBaseTicketPrice() { return adminConfigCache?.baseTicketPrice ?? 65; }
function getLunchAddonPrice() { return adminConfigCache?.lunchAddonPrice ?? 20; }
const MIN_PIX_EXPIRATION_HOURS = 24;

const REQUIRED_ENV = ['MERCADO_PAGO_ACCESS_TOKEN', 'SESSION_SECRET', 'ADMIN_PASSWORD'];
const missingEnv = REQUIRED_ENV.filter((k) => !process.env[k]);
if (!MONGODB_URI) {
  missingEnv.push('MONGODB_URI');
}
if (!process.env.MERCADO_PAGO_PUBLIC_KEY) {
  missingEnv.push('MERCADO_PAGO_PUBLIC_KEY');
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

function getSingleTicketCap(quantityWithoutLunch, quantityWithLunch) {
  return quantityWithLunch > 0
    ? getBaseTicketPrice() + getLunchAddonPrice()
    : quantityWithoutLunch > 0
      ? getBaseTicketPrice()
      : 0;
}

function resolveCouponDiscountValue(coupon, referenceAmount, totalQty = 1) {
  if (!coupon || !Number.isFinite(referenceAmount) || referenceAmount <= 0) {
    return 0;
  }

  const rawAmount = Number(coupon.discountAmount || 0);
  if (!Number.isFinite(rawAmount) || rawAmount <= 0) {
    return 0;
  }

  const mode = String(coupon.discountMode || 'fixed').toLowerCase();
  if (mode === 'percent') {
    return Number((referenceAmount * (rawAmount / 100)).toFixed(2));
  }
  
  if (mode === 'per_ticket') {
    return Number((rawAmount * totalQty).toFixed(2));
  }

  return rawAmount;
}

function calcAmounts(quantityWithoutLunch, quantityWithLunch, caravanDiscountValue, leaderDiscountValue) {
  const subtotal =
    quantityWithoutLunch * getBaseTicketPrice() +
    quantityWithLunch * (getBaseTicketPrice() + getLunchAddonPrice());

  const maxDiscount = Math.max(0, subtotal - 0.01);
  const singleTicketCap = getSingleTicketCap(quantityWithoutLunch, quantityWithLunch);

  const caravanDiscountAmount = Math.max(caravanDiscountValue || 0, 0);
  const leaderDiscountAmount = Math.min(Math.max(leaderDiscountValue || 0, 0), singleTicketCap);
  const discountAmount = Math.min(caravanDiscountAmount + leaderDiscountAmount, maxDiscount);

  let adjustedCaravanDiscount = caravanDiscountAmount;
  let adjustedLeaderDiscount = leaderDiscountAmount;

  if (discountAmount < caravanDiscountAmount + leaderDiscountAmount) {
    const overflow = caravanDiscountAmount + leaderDiscountAmount - discountAmount;
    adjustedLeaderDiscount = Math.max(0, leaderDiscountAmount - overflow);
  }

  const total = Number((subtotal - discountAmount).toFixed(2));

  return {
    subtotal: Number(subtotal.toFixed(2)),
    caravanDiscountAmount: Number(adjustedCaravanDiscount.toFixed(2)),
    leaderDiscountAmount: Number(adjustedLeaderDiscount.toFixed(2)),
    discountAmount: Number(discountAmount.toFixed(2)),
    total
  };
}

function couponBadgeType(caravanCoupon) {
  return caravanCoupon ? 'caravana' : 'individual';
}

function resolvePixExpirationDate() {
  const raw = Number(process.env.PIX_EXPIRATION_HOURS || MIN_PIX_EXPIRATION_HOURS);
  const hours = Number.isFinite(raw) && raw >= MIN_PIX_EXPIRATION_HOURS
    ? raw
    : MIN_PIX_EXPIRATION_HOURS;

  return new Date(Date.now() + hours * 60 * 60 * 1000);
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

  if (tx.status === 'approved' && !tx.emailSent) {
    sendConfirmationEmail(tx); // não damos await para não travar
  }

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

function resolveTrustProxy() {
  const raw = String(process.env.TRUST_PROXY || '1').trim().toLowerCase();

  if (raw === 'true') return true;
  if (raw === 'false') return false;

  const hops = Number(raw);
  if (Number.isInteger(hops) && hops >= 0) {
    return hops;
  }

  // Valor padrão compatível com ambientes atrás de 1 proxy.
  return 1;
}

app.set('trust proxy', resolveTrustProxy());

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'script-src': ["'self'", "'unsafe-inline'", 'https://sdk.mercadopago.com'],
        'img-src': ["'self'", 'data:', 'https://http2.mlstatic.com', 'https://www.mercadolibre.com'],
        'frame-src': ["'self'", 'https://www.mercadopago.com', 'https://sdk.mercadopago.com', 'https://www.mercadolibre.com'],
        'connect-src': ["'self'", 'https://api.mercadopago.com', 'https://sdk.mercadopago.com', 'https://api.mercadolibre.com', 'https://www.mercadolibre.com']
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
      base: getBaseTicketPrice(),
      lunch: getLunchAddonPrice()
    },
    publicKey: process.env.MERCADO_PAGO_PUBLIC_KEY
  });
});

app.get('/api/calculate-price', async (req, res) => {
  try {
    const quantityWithoutLunch = parseQty(req.query.quantityWithoutLunch);
    const quantityWithLunch = parseQty(req.query.quantityWithLunch);
    const couponInput = String(req.query.couponCode || '').trim().toLowerCase();

    let caravanCoupon = null;
    let leaderCoupon = null;

    if (couponInput) {
      caravanCoupon = await Coupon.findOne({
        code: couponInput,
        couponType: 'caravana',
        isActive: true
      });
      if (!caravanCoupon) {
        leaderCoupon = await Coupon.findOne({
          code: couponInput,
          couponType: 'lider',
          isActive: true
        });

        // Validar se cupom de líder já foi usado (se for singleUse)
        if (leaderCoupon && leaderCoupon.singleUse && leaderCoupon.usageCount > 0) {
          return res.json({
            success: false,
            error: 'Este cupom de líder já foi utilizado.',
            couponStatus: 'invalid'
          });
        }
      }
    }

    const subtotalPreview =
      quantityWithoutLunch * getBaseTicketPrice() +
      quantityWithLunch * (getBaseTicketPrice() + getLunchAddonPrice());
    const singleTicketCap = getSingleTicketCap(quantityWithoutLunch, quantityWithLunch);

    const totalQty = quantityWithoutLunch + quantityWithLunch;

    const amounts = calcAmounts(
      quantityWithoutLunch,
      quantityWithLunch,
      resolveCouponDiscountValue(caravanCoupon, subtotalPreview, totalQty),
      resolveCouponDiscountValue(leaderCoupon, singleTicketCap, 1)
    );

    res.json({
      success: true,
      amounts,
      couponStatus: couponInput ? (caravanCoupon || leaderCoupon ? 'valid' : 'invalid') : 'none'
    });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Erro ao calcular' });
  }
});

app.post('/checkout', requireCsrf, async (req, res) => {
  const buyerName = String(req.body.buyerName || '').trim();
  const buyerEmail = String(req.body.buyerEmail || '').trim().toLowerCase();
  const buyerPhone = String(req.body.buyerPhone || '').trim();
  const quantityWithoutLunch = parseQty(req.body.quantityWithoutLunch);
  const quantityWithLunch = parseQty(req.body.quantityWithLunch);
  const totalTickets = quantityWithoutLunch + quantityWithLunch;
  const paymentMethod = 'pix';
  const caravanCouponInput = String(req.body.caravanCouponCode || '').trim().toLowerCase();
  const leaderCouponInput = String(req.body.leaderCouponCode || '').trim().toLowerCase();

  if (!buyerName || !buyerEmail) {
    return res.status(400).render('index', {
      error: 'Informe nome e e-mail para a inscrição.',
      message: null,
      prices: { base: getBaseTicketPrice(), lunch: getLunchAddonPrice() },
      publicKey: process.env.MERCADO_PAGO_PUBLIC_KEY
    });
  }

  if (totalTickets <= 0) {
    return res.status(400).render('index', {
      error: 'Informe ao menos 1 ingresso.',
      message: null,
      prices: { base: getBaseTicketPrice(), lunch: getLunchAddonPrice() },
      publicKey: process.env.MERCADO_PAGO_PUBLIC_KEY
    });
  }

  if (caravanCouponInput && leaderCouponInput) {
    return res.status(400).render('index', {
      error: 'Use apenas 1 cupom por compra. Não é possível combinar cupom de caravana e de líder.',
      message: null,
      prices: { base: getBaseTicketPrice(), lunch: getLunchAddonPrice() },
      publicKey: process.env.MERCADO_PAGO_PUBLIC_KEY
    });
  }

  let caravanCoupon = null;
  let leaderCoupon = null;

  if (caravanCouponInput) {
    caravanCoupon = await Coupon.findOne({
      code: caravanCouponInput,
      couponType: 'caravana',
      isActive: true
    });

    if (!caravanCoupon) {
      return res.status(400).render('index', {
        error: 'Cupom de caravana inválido.',
        message: null,
        prices: { base: getBaseTicketPrice(), lunch: getLunchAddonPrice() },
        publicKey: process.env.MERCADO_PAGO_PUBLIC_KEY
      });
    }
  }

  if (leaderCouponInput) {
    leaderCoupon = await Coupon.findOne({
      code: leaderCouponInput,
      couponType: 'lider',
      isActive: true
    });

    if (!leaderCoupon) {
      return res.status(400).render('index', {
        error: 'Cupom de líder inválido.',
        message: null,
        prices: { base: getBaseTicketPrice(), lunch: getLunchAddonPrice() },
        publicKey: process.env.MERCADO_PAGO_PUBLIC_KEY
      });
    }

    // Verificar se cupom de líder já foi usado (se for singleUse)
    if (leaderCoupon.singleUse && leaderCoupon.usageCount > 0) {
      return res.status(400).render('index', {
        error: 'Este cupom de líder já foi utilizado e não pode ser reutilizado.',
        message: null,
        prices: { base: getBaseTicketPrice(), lunch: getLunchAddonPrice() },
        publicKey: process.env.MERCADO_PAGO_PUBLIC_KEY
      });
    }
  }

  const subtotalPreview =
    quantityWithoutLunch * getBaseTicketPrice() +
    quantityWithLunch * (getBaseTicketPrice() + getLunchAddonPrice());
  const singleTicketCap = getSingleTicketCap(quantityWithoutLunch, quantityWithLunch);

  const amounts = calcAmounts(
    quantityWithoutLunch,
    quantityWithLunch,
    resolveCouponDiscountValue(caravanCoupon, subtotalPreview, totalTickets),
    resolveCouponDiscountValue(leaderCoupon, singleTicketCap, 1)
  );
  const localPaymentId = crypto.randomUUID();

  try {
    // Se é cupom de líder, não gera PIX, apenas cria a transação com status "to_confirm"
    if (leaderCoupon) {
      const transactionData = {
        localPaymentId,
        buyerName,
        buyerEmail,
        buyerPhone,
        paymentMethod: 'leader_confirmation',
        purchaseType: 'individual',
        quantityWithoutLunch,
        quantityWithLunch,
        totalTickets,
        baseTicketPrice: getBaseTicketPrice(),
        lunchAddonPrice: getLunchAddonPrice(),
        subtotalAmount: amounts.subtotal,
        caravanDiscountAmount: amounts.caravanDiscountAmount,
        leaderDiscountAmount: amounts.leaderDiscountAmount,
        discountAmount: amounts.discountAmount,
        leaderCouponCode: leaderCoupon.code,
        couponCode: leaderCoupon.code,
        amount: amounts.total,
        status: 'to_confirm',
        statusDetail: 'awaiting_confirmation',
        leaderConfirmed: false
      };

      const createdTx = await Transaction.create(transactionData);

      // Marcar cupom de líder como usado
      leaderCoupon.usageCount += 1;
      leaderCoupon.lastUsedAt = new Date();
      leaderCoupon.lastUsedByPaymentId = localPaymentId;
      await leaderCoupon.save();

      return res.redirect(`/payment/${localPaymentId}`);
    }

    // Fluxo normal de PIX para caravana ou sem cupom
    const pixExpirationDate = resolvePixExpirationDate();
    const webhookUrl = buildWebhookUrl();

    const paymentData = {
      transaction_amount: amounts.total,
      payment_method_id: 'pix',
      description: `Ingressos: ${totalTickets} (${quantityWithLunch} c/ almoço)`,
      external_reference: localPaymentId,
      date_of_expiration: pixExpirationDate.toISOString(),
      payer: {
        email: buyerEmail,
        first_name: buyerName
      }
    };

    if (webhookUrl) {
      paymentData.notification_url = webhookUrl;
    }

    let payment;
    try {
      payment = await mercadopago.payment.create(paymentData);
    } catch (createError) {
      if (paymentData.notification_url) {
        console.warn('Falha ao criar pagamento com webhook. Tentando sem webhook...', createError.message);
        delete paymentData.notification_url;
        payment = await mercadopago.payment.create(paymentData);
      } else {
        throw createError;
      }
    }

    const txData = payment.body?.point_of_interaction?.transaction_data || {};

    await Transaction.create({
      localPaymentId,
      buyerName,
      buyerEmail,
      buyerPhone,
      paymentMethod,
      purchaseType: couponBadgeType(caravanCoupon),
      quantityWithoutLunch,
      quantityWithLunch,
      totalTickets,
      baseTicketPrice: getBaseTicketPrice(),
      lunchAddonPrice: getLunchAddonPrice(),
      subtotalAmount: amounts.subtotal,
      caravanDiscountAmount: amounts.caravanDiscountAmount,
      leaderDiscountAmount: amounts.leaderDiscountAmount,
      discountAmount: amounts.discountAmount,
      caravanCouponCode: caravanCoupon?.code || null,
      leaderCouponCode: leaderCoupon?.code || null,
      couponCode: caravanCoupon?.code || leaderCoupon?.code || null,
      amount: amounts.total,
      status: mapMpStatus(payment.body?.status),
      statusDetail: payment.body?.status_detail || null,
      mpPaymentId: payment.body?.id ? String(payment.body.id) : null,
      externalReference: localPaymentId,
      qrCode: txData.qr_code || null,
      qrCodeBase64: txData.qr_code_base64 || null,
      ticketUrl: txData.ticket_url || null,
      expiresAt: payment.body?.date_of_expiration ? new Date(payment.body.date_of_expiration) : pixExpirationDate,
      lastCheckedAt: null
    });

    if (caravanCoupon) {
      caravanCoupon.usageCount += 1;
      caravanCoupon.lastUsedAt = new Date();
      caravanCoupon.lastUsedByPaymentId = localPaymentId;
      await caravanCoupon.save();
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
      prices: { base: getBaseTicketPrice(), lunch: getLunchAddonPrice() },
      publicKey: process.env.MERCADO_PAGO_PUBLIC_KEY
    });
  }
});

app.post('/payments/:localPaymentId/card', async (req, res) => {
  const token = String(req.body.token || '');
  const paymentMethodId = String(req.body.paymentMethodId || '');
  const issuerId = req.body.issuerId ? String(req.body.issuerId) : undefined;
  const installments = Number(req.body.installments || 1);
  const identificationType = String(req.body.identificationType || 'CPF');
  const identificationNumber = String(req.body.identificationNumber || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();

  if (!token || !paymentMethodId || !email || !identificationNumber) {
    return res.status(400).json({ error: 'Dados do cartão incompletos.' });
  }

  const tx = await Transaction.findOne({ localPaymentId: req.params.localPaymentId });
  if (!tx) {
    return res.status(404).json({ error: 'Pagamento não encontrado.' });
  }

  if (tx.paymentMethod !== 'card') {
    return res.status(400).json({ error: 'Essa inscrição não está configurada para cartão.' });
  }

  try {
    const webhookUrl = buildWebhookUrl();
    const paymentData = {
      transaction_amount: tx.amount,
      token,
      description: `Ingressos: ${tx.totalTickets} (${tx.quantityWithLunch} c/ almoço)`,
      installments: Number.isFinite(installments) && installments > 0 ? installments : 1,
      payment_method_id: paymentMethodId,
      external_reference: tx.localPaymentId,
      payer: {
        email,
        identification: {
          type: identificationType,
          number: identificationNumber
        }
      }
    };

    if (issuerId) {
      paymentData.issuer_id = issuerId;
    }
    if (webhookUrl) {
      paymentData.notification_url = webhookUrl;
    }

    let payment;
    try {
      payment = await mercadopago.payment.create(paymentData);
    } catch (createError) {
      if (paymentData.notification_url) {
        console.warn('Falha ao criar pagamento com webhook. Tentando sem webhook...', createError.message);
        delete paymentData.notification_url;
        payment = await mercadopago.payment.create(paymentData);
      } else {
        throw createError;
      }
    }

    tx.status = mapMpStatus(payment.body?.status);
    tx.statusDetail = payment.body?.status_detail || null;
    tx.mpPaymentId = payment.body?.id ? String(payment.body.id) : null;
    tx.installments = payment.body?.installments || paymentData.installments;
    tx.cardFirstSixDigits = payment.body?.card?.first_six_digits || null;
    tx.cardLastFourDigits = payment.body?.card?.last_four_digits || null;
    tx.lastCheckedAt = new Date();
    await tx.save();

    return res.json({
      ok: true,
      status: tx.status,
      redirectTo: `/payment/${tx.localPaymentId}`
    });
  } catch (error) {
    const apiMessage =
      error?.cause?.[0]?.description ||
      error?.message ||
      'Falha ao processar cartão.';
    return res.status(400).json({ error: apiMessage });
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
      base: getBaseTicketPrice(),
      lunch: getLunchAddonPrice()
    },
    publicKey: process.env.MERCADO_PAGO_PUBLIC_KEY
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

app.post('/payment/:localPaymentId/confirm-leader', async (req, res) => {
  try {
    const tx = await Transaction.findOne({ localPaymentId: req.params.localPaymentId });

    if (!tx) {
      return res.status(404).json({ error: 'Inscrição não encontrada.' });
    }

    if (tx.status !== 'to_confirm') {
      return res.status(400).json({ error: 'Esta inscrição não está aguardando confirmação.' });
    }

    if (tx.leaderConfirmed) {
      return res.status(400).json({ error: 'Esta inscrição já foi confirmada.' });
    }

    // Marcar como confirmado
    tx.status = 'approved';
    tx.statusDetail = 'leader_confirmed';
    tx.leaderConfirmed = true;
    tx.lastCheckedAt = new Date();
    await tx.save();

    // Enviar email de confirmação
    sendLeaderConfirmationEmail(tx);

    return res.json({
      ok: true,
      status: tx.status,
      message: 'Inscrição confirmada com sucesso!'
    });
  } catch (error) {
    console.error('Erro ao confirmar inscrição de líder:', error.message);
    return res.status(500).json({ error: 'Erro ao confirmar inscrição.' });
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

    if (tx.status === 'approved' && !tx.emailSent) {
      sendConfirmationEmail(tx); // não damos await para não travar o webhook
    }

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

  const stats = {
    totalOrders: transactions.length,
    approvedOrders: transactions.filter((item) => item.status === 'approved').length,
    pendingOrders: transactions.filter((item) => item.status === 'pending' || item.status === 'awaiting_card').length,
    revenue: transactions
      .filter((item) => item.status === 'approved')
      .reduce((sum, item) => sum + Number(item.amount || 0), 0)
  };

  return res.render('admin-dashboard', {
    adminPath: req.params.slug,
    transactions,
    coupons,
    stats,
    prices: { base: getBaseTicketPrice(), lunch: getLunchAddonPrice() },
    error: null,
    message: null
  });
});

app.post('/admin/:slug/settings', requireAdminSlug, requireAdminAuth, requireCsrf, async (req, res) => {
  const basePrice = Number(req.body.baseTicketPrice);
  const lunchPrice = Number(req.body.lunchAddonPrice);

  if (!Number.isFinite(basePrice) || basePrice < 0 || !Number.isFinite(lunchPrice) || lunchPrice < 0) {
    return res.redirect(`/admin/${req.params.slug}/dashboard`);
  }

  const existing = await AdminSetting.findOne({ key: 'main' });
  if (existing) {
    existing.baseTicketPrice = basePrice;
    existing.lunchAddonPrice = lunchPrice;
    await existing.save();
    adminConfigCache = existing;
  }

  res.redirect(`/admin/${req.params.slug}/dashboard`);
});

app.post('/admin/:slug/coupons', requireAdminSlug, requireAdminAuth, requireCsrf, async (req, res) => {
  const code = String(req.body.code || '').trim().toLowerCase();
  const discountAmount = Number(req.body.discountAmount);
  const discountMode = String(req.body.discountMode || 'fixed').trim().toLowerCase();
  const couponType = String(req.body.couponType || '').trim().toLowerCase();

  const isDiscountModeValid = ['fixed', 'percent', 'per_ticket'].includes(discountMode);
  const isDiscountAmountValid = Number.isFinite(discountAmount) && discountAmount > 0;
  const isPercentInRange = discountMode !== 'percent' || discountAmount <= 100;

  if (!code || !['caravana', 'lider'].includes(couponType) || !isDiscountModeValid || !isDiscountAmountValid || !isPercentInRange) {
    const transactions = await Transaction.find({}).sort({ createdAt: -1 }).lean();
    const coupons = await Coupon.find({}).sort({ createdAt: -1 }).lean();
    return res.status(400).render('admin-dashboard', {
      adminPath: req.params.slug,
      transactions,
      coupons,
      stats: {
        totalOrders: transactions.length,
        approvedOrders: transactions.filter((item) => item.status === 'approved').length,
        pendingOrders: transactions.filter((item) => item.status === 'pending' || item.status === 'awaiting_card').length,
        revenue: transactions.filter((item) => item.status === 'approved').reduce((sum, item) => sum + Number(item.amount || 0), 0)
      },
      prices: { base: getBaseTicketPrice(), lunch: getLunchAddonPrice() },
      error: 'Cupom inválido. Informe tipo, código e desconto válido (percentual até 100%).',
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
      stats: {
        totalOrders: transactions.length,
        approvedOrders: transactions.filter((item) => item.status === 'approved').length,
        pendingOrders: transactions.filter((item) => item.status === 'pending' || item.status === 'awaiting_card').length,
        revenue: transactions.filter((item) => item.status === 'approved').reduce((sum, item) => sum + Number(item.amount || 0), 0)
      },
      prices: { base: getBaseTicketPrice(), lunch: getLunchAddonPrice() },
      error: 'Esse cupom já existe.',
      message: null
    });
  }

  await Coupon.create({
    code,
    couponType,
    discountMode,
    discountAmount,
    createdBy: 'admin'
  });

  return res.redirect(`/admin/${req.params.slug}/dashboard`);
});

app.delete('/admin/:slug/coupons/:couponId', requireAdminSlug, requireAdminAuth, requireCsrf, async (req, res) => {
  const couponId = String(req.params.couponId || '').trim();
  
  if (!couponId) {
    return res.status(400).json({ error: 'ID do cupom inválido.' });
  }

  try {
    const coupon = await Coupon.findById(couponId);
    if (!coupon) {
      return res.status(404).json({ error: 'Cupom não encontrado.' });
    }

    await Coupon.deleteOne({ _id: couponId });
    return res.json({ success: true, message: 'Cupom deletado com sucesso.' });
  } catch (error) {
    console.error('Erro ao deletar cupom:', error);
    return res.status(500).json({ error: 'Erro ao deletar cupom.' });
  }
});

app.post('/admin/:slug/coupons/:couponId/delete', requireAdminSlug, requireAdminAuth, requireCsrf, async (req, res) => {
  const couponId = String(req.params.couponId || '').trim();

  if (!couponId) {
    return res.status(400).redirect(`/admin/${req.params.slug}/dashboard`);
  }

  try {
    await Coupon.deleteOne({ _id: couponId });
    return res.redirect(`/admin/${req.params.slug}/dashboard`);
  } catch (error) {
    console.error('Erro ao deletar cupom por POST:', error);
    return res.status(500).redirect(`/admin/${req.params.slug}/dashboard`);
  }
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
