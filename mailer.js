const nodemailer = require('nodemailer');
// Força o Node.js a priorizar IPv4 para evitar o erro ENETUNREACH no Render com IPv6
require('node:dns').setDefaultResultOrder('ipv4first');

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

function formatData(date) {
  const options = { timeZone: 'America/Sao_Paulo' };
  if (!date) return new Date().toLocaleString('pt-BR', options);
  return new Date(date).toLocaleString('pt-BR', options);
}

async function sendConfirmationEmail(transaction) {
  if (!transaction || transaction.emailSent) return;

  const totalTickets = transaction.totalTickets;
  const paymentMethodStr = transaction.paymentMethod === 'pix' ? 'PIX' : 'Cartão';
  const discountLine = transaction.discountAmount > 0 
    ? `<li style="margin-bottom: 8px;"><strong>Desconto Aplicado:</strong> R$ ${transaction.discountAmount.toFixed(2)}</li>`
    : '';

  const htmlContent = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden;">
      <div style="background-color: #2563eb; color: #ffffff; padding: 20px; text-align: center;">
        <h2 style="margin: 0; font-size: 24px;">Inscrição Confirmada!</h2>
        <p style="margin: 5px 0 0 0; opacity: 0.9;">Guarde este e-mail como seu comprovante de inscrição</p>
      </div>

      <div style="padding: 24px;">
        <p>Olá, <strong>${transaction.buyerName}</strong>.</p>
        <p>Recebemos o seu pagamento e sua inscrição está garantida.</p>
        
        <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; padding: 16px; border-radius: 8px; margin: 24px 0;">
          <h3 style="margin-top: 0; font-size: 18px; color: #1e293b; border-bottom: 2px solid #e2e8f0; padding-bottom: 8px;">Comprovante de Pagamento</h3>
          
          <ul style="list-style-type: none; padding: 0; margin: 0; font-size: 15px; line-height: 1.6;">
            <li style="margin-bottom: 8px;"><strong>Status:</strong> <span style="color: #16a34a; font-weight: bold;">✔ Aprovado</span></li>
            <li style="margin-bottom: 8px;"><strong>Data e Hora:</strong> ${formatData(transaction.lastCheckedAt || transaction.updatedAt)}</li>
            <li style="margin-bottom: 8px;"><strong>Método de Pagamento:</strong> ${paymentMethodStr}</li>
            <li style="margin-bottom: 8px;"><strong>Código Local:</strong> ${transaction.localPaymentId}</li>
            <li style="margin-bottom: 16px;"><strong>ID da Transação (Mercado Pago):</strong> ${transaction.mpPaymentId || 'N/A'}</li>
            
            <h4 style="margin: 16px 0 8px 0; font-size: 16px; color: #334155;">Resumo da Inscrição</h4>
            <li style="margin-bottom: 8px;"><strong>Total de Ingressos:</strong> ${totalTickets}</li>
            <li style="margin-bottom: 8px;">Com almoço: ${transaction.quantityWithLunch} | Sem almoço: ${transaction.quantityWithoutLunch}</li>
            ${discountLine}
            
            <div style="margin-top: 16px; padding-top: 16px; border-top: 2px dashed #cbd5e1;">
              <li style="font-size: 18px;"><strong>Total Pago:</strong> <span style="color: #2563eb; font-weight: bold;">R$ ${transaction.amount.toFixed(2)}</span></li>
            </div>
          </ul>
        </div>

        <p>Apresente este comprovante (impresso ou no celular) e um documento com foto no dia do evento.</p>
        <p style="margin-bottom: 0;">Agradecemos a sua compra e estamos à disposição.</p>
      </div>
    </div>
  `;

  try {
    const mailOptions = {
      from: `"Inscrições" <${process.env.EMAIL_USER || 'isaachonorato41@gmail.com'}>`,
      to: transaction.buyerEmail,
      subject: 'Confirmação de Inscrição - Pedido Aprovado',
      html: htmlContent
    };

    await transporter.sendMail(mailOptions);
    console.log(`E-mail de confirmação enviado para ${transaction.buyerEmail}`);
    
    // Atualiza a transação para evitar envios duplicados
    transaction.emailSent = true;
    await transaction.save();
  } catch (err) {
    console.error('Erro ao enviar email de confirmação:', err.message);
  }
}

module.exports = { sendConfirmationEmail };
