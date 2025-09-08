cat > index.js << 'EOF'
const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  GroupMetadata,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const chalk = require("chalk");
const dayjs = require("dayjs");
const fs = require('fs');
const path = require('path');

// --- Configuración y Constantes ---
const SESSION_PATH = path.join(__dirname, 'session');
const PREFIX = '.';
const ARABIC_PREFIXES = ['966', '965', '964', '963', '962', '961', '970', '971', '973', '974', '968', '967', '249', '213', '218', '216', '212', '20'];

// --- Sistema de Logs (Profesional) ---
function timestamp() {
  return dayjs().format("YYYY-MM-DD HH:mm:ss");
}

const logger = {
  info: (...msg) => console.log(chalk.blue(`[INFO ${timestamp()}]`), ...msg),
  warn: (...msg) => console.log(chalk.yellow(`[WARN ${timestamp()}]`), ...msg),
  error: (...msg) => console.log(chalk.red(`[ERROR ${timestamp()}]`), ...msg),
  success: (...msg) => console.log(chalk.green(`[SUCCESS ${timestamp()}]`), ...msg),
  log: (...msg) => console.log(chalk.white(`[LOG ${timestamp()}]`), ...msg),
};

// --- Funciones Anti-Moderación ---
const isUserAdmin = async (sock, groupId, userId) => {
    try {
        const groupMetadata = await sock.groupMetadata(groupId);
        const user = groupMetadata.participants.find(p => p.id === userId);
        return user && (user.admin === 'superadmin' || user.admin === 'admin');
    } catch (e) {
        logger.error(`Error al verificar si el usuario es admin: ${e.message}`);
        return false;
    }
};

const isArabicUser = (userId) => {
    const countryCode = userId.split('@')[0].substring(0, 3);
    return ARABIC_PREFIXES.includes(countryCode);
};

// --- Función Principal del Bot ---
async function startBotNoa() {
    logger.info('Iniciando el bot Noa...');
    
    if (!fs.existsSync(SESSION_PATH)) fs.mkdirSync(SESSION_PATH);

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        browser: Browsers.macOS("Desktop"),
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            qrcode.generate(qr, { small: true });
            logger.info('Por favor, escanea el código QR para iniciar la sesión.');
        }
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            logger.warn(`Conexión cerrada. Razón: ${lastDisconnect.error?.message}. Intentando reconectar: ${shouldReconnect}`);
            if (shouldReconnect) {
                startBotNoa();
            }
        } else if (connection === 'open') {
            logger.success('✅ Bot Noa conectado a WhatsApp!');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe || m.key.id.startsWith('BAE5')) return;
        
        const messageText = m.message?.conversation || m.message?.extendedTextMessage?.text || '';
        const senderJid = m.key.remoteJid;
        const isGroup = senderJid.endsWith('@g.us');

        // --- Anti-Link (para grupos) ---
        const linkRegex = /(https?:\/\/|www\.)[^\s]+/gi;
        if (isGroup && messageText.match(linkRegex)) {
            const senderIsAdmin = await isUserAdmin(sock, senderJid, m.key.participant || m.key.remoteJid);
            if (!senderIsAdmin) {
                logger.warn(`🚫 Anti-Link: ${m.key.participant || m.key.remoteJid} ha enviado un enlace.`);
                try {
                    await sock.sendMessage(senderJid, { delete: m.key });
                    await sock.groupParticipantsUpdate(senderJid, [m.key.participant || m.key.remoteJid], 'remove');
                    await sock.sendMessage(senderJid, { text: '🚫 Se ha detectado un enlace no permitido. El usuario ha sido expulsado.' });
                } catch (e) {
                    logger.error(`❌ Error al expulsar usuario por anti-link: ${e.message}`);
                }
                return;
            }
        }

        // --- Comando .kick (solo para admins) ---
        if (isGroup && messageText.startsWith(PREFIX + 'kick')) {
            const senderIsAdmin = await isUserAdmin(sock, senderJid, m.key.participant || m.key.remoteJid);
            if (!senderIsAdmin) {
                await sock.sendMessage(senderJid, { text: '❌ Solo los administradores pueden usar este comando.' });
                return;
            }

            const mentions = m.message?.extendedTextMessage?.contextInfo?.mentionedJid;
            if (!mentions || mentions.length === 0) {
                await sock.sendMessage(senderJid, { text: '❌ Por favor, menciona a un usuario para expulsarlo.' });
                return;
            }

            const userToKick = mentions[0];
            try {
                await sock.groupParticipantsUpdate(senderJid, [userToKick], 'remove');
                await sock.sendMessage(senderJid, { text: `✅ Usuario @${userToKick.split('@')[0]} ha sido expulsado.` });
                logger.info(`Comando .kick ejecutado en ${senderJid} para expulsar a ${userToKick}.`);
            } catch (e) {
                logger.error(`❌ Error al expulsar al usuario con .kick: ${e.message}`);
                await sock.sendMessage(senderJid, { text: '❌ No pude expulsar al usuario. Asegúrate de que el bot tiene permisos de administrador.' });
            }
        }
    });

    // --- Anti-Árabe (siempre activo al unirse) ---
    sock.ev.on('group-participants.update', async (groupData) => {
        const { id, participants, action } = groupData;
        if (action === 'add') {
            const newMemberJid = participants[0];
            if (isArabicUser(newMemberJid)) {
                logger.warn(`🚫 Anti-Árabe: ${newMemberJid} se unió. Expulsándolo.`);
                try {
                    await sock.groupParticipantsUpdate(id, [newMemberJid], 'remove');
                    await sock.sendMessage(id, { text: '🚫 Un usuario con un prefijo de país no permitido se ha unido y ha sido expulsado.' });
                } catch (e) {
                    logger.error(`❌ Error al expulsar usuario por anti-árabe: ${e.message}`);
                    await sock.sendMessage(id, { text: '❌ Un usuario no permitido se ha unido, pero el bot no tiene permisos para expulsarlo.' });
                }
            }
        }
    });
}

startBotNoa();
EOF