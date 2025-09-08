import {
    makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import P from 'pino';
import fs from 'fs';
import qrcode from 'qrcode-terminal';

// --- Configuración y Constantes ---
const SESSION_PATH = "auth_info";
const LOG_FILE = "./logs.txt";
const warnings = {}; // { [groupJid]: { [userJid]: count } }

function logToFile(message) {
    const timestamp = new Date().toLocaleString();
    const fullMessage = `[${timestamp}] ${message}\n`;
    console.log(fullMessage);
    fs.appendFileSync(LOG_FILE, fullMessage);
}

// --- Función Principal del Bot ---
async function startBot() {
    // Esto crea la carpeta de sesión si no existe
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        printQRInTerminal: true,
        auth: state,
        logger: P({ level: "silent" }),
    });

    // Esto guarda la sesión cuando se actualiza
    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("messages.upsert", async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.participant || msg.key.remoteJid;
        const chat = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

        if (!chat.endsWith("@g.us")) return;

        let groupMetadata;
        try {
            groupMetadata = await sock.groupMetadata(chat);
        } catch (e) {
            logToFile(`Error al obtener metadatos del grupo: ${e.message}`);
            return;
        }

        const botAdmin = groupMetadata.participants.find(p => p.id.includes(sock.user.id.split(":")[0]))?.admin || false;

        if (!warnings[chat]) warnings[chat] = {};
        if (!warnings[chat][sender]) warnings[chat][sender] = 0;

        // Anti-link
        if (text && /(https?:\/\/[^\s]+)/.test(text)) {
            warnings[chat][sender]++;
            const warnCount = warnings[chat][sender];

            if (warnCount === 1) {
                await sock.sendMessage(chat, { text: `⚠️ Advertencia 1/3: No se permiten links.` }, { quoted: msg });
            } else if (warnCount === 2) {
                await sock.sendMessage(chat, { text: `⚠️ Advertencia 2/3: Tu mensaje será eliminado.` }, { quoted: msg });
                await sock.sendMessage(chat, { delete: msg.key });
            } else if (warnCount >= 3) {
                await sock.sendMessage(chat, { delete: msg.key });
                if (botAdmin) {
                    await sock.groupParticipantsUpdate(chat, [sender], "remove");
                    await sock.sendMessage(chat, { text: `❌ @${sender.split('@')[0]} eliminado por tercera infracción.` });
                    logToFile(`${sender} kickeado en ${groupMetadata.subject} (3ra infracción)`);
                } else {
                    logToFile(`No se pudo kickear a ${sender} en ${groupMetadata.subject}, el bot no es admin.`);
                }
                warnings[chat][sender] = 0;
            }

            logToFile(
                `Grupo: ${groupMetadata.subject}\n` +
                `Bot admin: ${botAdmin}\n` +
                `Número remitente: ${sender}\n` +
                `Mensaje: ${text}\n` +
                `Advertencia: ${warnCount}`
            );
        }

        // Comando .kick
        if (text && text.startsWith(".kick")) {
            const senderAdmin = groupMetadata.participants.find(p => p.id === sender)?.admin;
            if (!senderAdmin) {
                await sock.sendMessage(chat, { text: "❌ Solo admins pueden usar este comando." }, { quoted: msg });
                return;
            }
            
            const mentions = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
            if (mentions.length === 0) {
                await sock.sendMessage(chat, { text: "❌ Por favor, menciona a un usuario para expulsarlo." }, { quoted: msg });
                return;
            }

            const target = mentions[0];

            if (botAdmin) {
                await sock.groupParticipantsUpdate(chat, [target], "remove");
                await sock.sendMessage(chat, { text: `✅ @${target.split('@')[0]} ha sido eliminado por admin.` });
                logToFile(`${target} kickeado por admin en ${groupMetadata.subject}`);
            } else {
                await sock.sendMessage(chat, { text: "❌ No puedo kickear, necesito ser admin." });
            }
        }
    });

    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === "close") {
            logToFile("Conexión cerrada, reintentando...");
            if ((lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut) {
                startBot();
            }
        } else if (connection === "open") {
            logToFile("✅ Bot conectado correctamente.");
        }
    });
}

startBot();