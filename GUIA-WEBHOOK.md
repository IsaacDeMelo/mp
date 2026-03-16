# Webhook e BASE_URL (Mercado Pago PIX)

## Por que a BASE_URL existe?

O Mercado Pago precisa chamar sua aplicação quando o status do PIX muda (`pending` -> `approved`, etc.).

Para isso, ele precisa de uma URL pública HTTPS para alcançar seu endpoint:

`/webhook/mercadopago`

Se sua aplicação estiver só em `localhost`, o Mercado Pago não consegue acessar.

## O que acontece sem BASE_URL?

- O pagamento PIX ainda é criado normalmente.
- O status ainda pode ser atualizado quando você reabre a cobrança (consulta via API no backend).
- Mas a atualização automática em segundo plano (webhook) fica desativada.

## Como usar em teste (ngrok)

1. Inicie a aplicação (porta 3000).
2. Abra um túnel HTTPS para a porta 3000.
3. Copie a URL pública gerada (exemplo: `https://abc123.ngrok-free.app`).
4. Atualize `.env`:
   - `BASE_URL=https://abc123.ngrok-free.app`
   - `MERCADO_PAGO_WEBHOOK_TOKEN=<token forte>`
5. No painel do Mercado Pago (credenciais de teste), configure webhook:
   - `https://abc123.ngrok-free.app/webhook/mercadopago?token=<mesmo_token_do_env>`

Pronto: o status passa a atualizar automaticamente mesmo se você fechar e voltar depois.
