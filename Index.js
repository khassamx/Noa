const { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

async function connectToWhatsApp() {
    const sessionPath = path.join(__dirname, 'auth_info_baileys');
    if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath);

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    const sock = makeWASocket({
        auth: state,
        browser: Browsers.macOS("Desktop"),
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            qrcode.generate(qr, { small: true });
            console.log('Por favor, escanea el código QR.');
        }
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Conexión cerrada. Razón:', lastDisconnect.error, ', intentando reconectar:', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('Conexión exitosa a WhatsApp!');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message) return;

        const messageText = m.message?.conversation || m.message?.extendedTextMessage?.text || '';
        const isCommand = messageText.startsWith('.');

        if (isCommand) {
            const command = messageText.substring(1).split(' ')[0];
            if (command === 'hola') {
                await sock.sendMessage(m.key.remoteJid, { text: '¡Hola! Soy un bot simple y funcional.' });
            }
        }
    });
}

connectToWhatsApp();