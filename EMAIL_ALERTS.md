# Alertas automáticos de prazo por e-mail

## O que foi adicionado
- Cadastro de e-mail no formulário de operadores.
- Cloud Function programada a cada 15 minutos para verificar OS ativas.
- Envio de um único aviso quando o prazo efetivo restante entrar na janela de 24 horas.
- OS pendenciadas ou concluídas não recebem aviso enquanto estiverem nesses estados.
- O cálculo considera os dias úteis e feriados nacionais/estaduais do RJ conforme o calendário usado pelo frontend, além do tempo de pausa acumulado na OS.
- Um documento em `deadlineReminders` evita repetir o aviso para o mesmo vencimento. Se o vencimento da OS for alterado, um novo aviso poderá ser enviado.

## Pré-requisitos
1. Projeto Firebase no plano Blaze (Cloud Functions agendadas podem exigir faturamento).
2. Node.js 22 e Firebase CLI no Cloud Shell.
3. Uma conta/provedor SMTP que autorize envio de e-mail. Use uma senha de aplicativo ou credencial SMTP própria; não use a senha normal de uma conta pessoal.
4. Configurar o SMTP como secrets do Firebase Functions.

## Configuração no Cloud Shell
Na raiz do repositório, execute:

```bash
npm --version
firebase --version
firebase use controleos-8851c
```

Se necessário, atualize o Firebase CLI:
```bash
npm install -g firebase-tools
```

Defina os secrets um por vez (o terminal pedirá o valor):
```bash
firebase functions:secrets:set SMTP_HOST
firebase functions:secrets:set SMTP_PORT
firebase functions:secrets:set SMTP_USER
firebase functions:secrets:set SMTP_PASS
firebase functions:secrets:set SMTP_FROM
```

Valores típicos dependem do provedor. Por exemplo, SMTP_PORT costuma ser 587 (TLS) ou 465 (SSL), mas confirme os dados com o seu provedor. SMTP_FROM deve ser um remetente autorizado.

Instale dependências e publique a função:
```bash
cd functions
npm install
cd ..
firebase deploy --only functions
```

Para publicar também o site após sincronizar o repositório:
```bash
git pull
mkdir -p public
cp index.html public/index.html
firebase deploy --only hosting
```

## Teste recomendado
- Cadastre o e-mail real de um operador.
- Crie uma OS de teste com prazo efetivo dentro das próximas 24 horas, em dia útil.
- Confirme a chegada do e-mail e o registro em Firestore > `deadlineReminders`.
- Teste também uma OS pendenciada: ela não deve receber alerta enquanto estiver pendenciada.
- Consulte os logs em Google Cloud Console > Cloud Functions / Logs Explorer.

## Observação sobre prazo
O app atual mede prazo em tempo útil de dias úteis (exclui fins de semana e feriados listados no código). A função segue essa regra e calcula a janela de 24 horas efetivas como 24 horas acumuladas em dias úteis. Se a regra desejada for 24 horas corridas, a lógica precisa ser alterada.
