import {
    makeWASocket,
    useMultiFileAuthState,
    DisconnectReason
} from '@whiskeysockets/baileys';
import P from 'pino';
import qrcode from 'qrcode-terminal';
import chalk from 'chalk';
import fs from 'fs';

// --- Configuración y Constantes ---
const SESSION_PATH = "auth_info";
const LOG_FILE = "./logs.txt";
global.owner = ["393939393939"]; 

// --- Sistema de Logs ---
function log(message) {
    const timestamp = new Date().toLocaleString();
    const fullMessage = `[${timestamp}] ${message}\n`;
    console.log(chalk.green(fullMessage));
    fs.appendFileSync(LOG_FILE, fullMessage);
}

// --- Función Principal del Bot ---
async function startBot() {
    log("Iniciando el bot...");

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);

    const sock = makeWASocket({
        auth: state,
        logger: P({ level: "silent" }),
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            qrcode.generate(qr, { small: true });
            log(chalk.yellow('Por favor, escanea el código QR para iniciar la sesión.'));
        }
        if (connection === "close") {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                log(chalk.red("Conexión cerrada. Reconectando..."));
                startBot();
            } else {
                log(chalk.red("Conexión cerrada. Sesión cerrada. Por favor, reinicia el bot para un nuevo QR."));
            }
        } else if (connection === "open") {
            log(chalk.cyan("✅ Bot conectado correctamente."));
        }
    });

    sock.ev.on("messages.upsert", async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.participant || msg.key.remoteJid;
        const chat = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

        // Muestra el mensaje que el bot "lee"
        if (text) {
            log(chalk.white(`[MENSAJE LEÍDO] De: ${sender.split('@')[0]} | Chat: ${chat} | Contenido: "${text}"`));
        }
        
        // Solo procesar mensajes en grupos
        if (!chat.endsWith("@g.us")) return;

        let groupMetadata;
        try {
            groupMetadata = await sock.groupMetadata(chat);
        } catch (e) {
            log(chalk.red(`Error al obtener metadatos del grupo: ${e.message}`));
            return;
        }

        const botIsAdmin = groupMetadata.participants.find(p => p.id.includes(sock.user.id.split(":")[0]))?.admin || false;
        const senderIsAdmin = groupMetadata.participants.find(p => p.id === sender)?.admin;

        // --- Múltiples Comandos de Kick ---
        const kickCommands = [".k", ".kick", "kick", "Kick", "#kick", "echar", "hechar", "sacar", "ban"];
        const isKickCommand = kickCommands.some(cmd => text.startsWith(cmd));
        
        if (isKickCommand) {
            if (!senderIsAdmin) {
                await sock.sendMessage(chat, { text: "❌ Solo los administradores pueden usar este comando." }, { quoted: msg });
                return;
            }
            if (!botIsAdmin) {
                await sock.sendMessage(chat, { text: "❌ No puedo kickear, necesito ser admin." }, { quoted: msg });
                return;
            }

            let target = null;
            const mentionedJid = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
            const quotedSender = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage ? msg.message.extendedTextMessage.contextInfo.participant : null;
            const args = text.split(" ");

            if (mentionedJid) {
                target = mentionedJid;
            } else if (quotedSender) {
                target = quotedSender;
            } else if (args[1]) {
                const number = args[1].replace(/[^0-9]/g, '');
                if (number) target = number + '@s.whatsapp.net';
            } else {
                await sock.sendMessage(chat, { text: '❌ Por favor, menciona, responde o escribe el número de alguien para expulsarlo.' }, { quoted: msg });
                return;
            }

            // Validaciones de seguridad
            const botOwnerJid = global.owner[0] + '@s.whatsapp.net';
            const groupOwnerJid = groupMetadata.owner || chat.split`-`[0] + '@s.whatsapp.net';
            
            if (target === sock.user.jid) {
                await sock.sendMessage(chat, { text: '❌ No puedo expulsarme a mí mismo.' }, { quoted: msg });
                return;
            }
            if (target === groupOwnerJid) {
                await sock.sendMessage(chat, { text: '❌ No se puede expulsar al dueño del grupo.' }, { quoted: msg });
                return;
            }
            if (target === botOwnerJid) {
                await sock.sendMessage(chat, { text: '❌ No se puede expulsar al dueño del bot.' }, { quoted: msg });
                return;
            }
            
            // Eliminar el mensaje que activó el comando
            await sock.sendMessage(chat, { delete: msg.key });
            
            try {
                await sock.groupParticipantsUpdate(chat, [target], "remove");
                await sock.sendMessage(chat, { react: { text: '👟', key: msg.key } }); // Reacción en el mensaje original
                await sock.sendMessage(chat, { text: `✅ @${target.split('@')[0]} ha sido eliminado.` });
                log(chalk.green(`[COMANDO] ${sender.split('@')[0]} expulsó a ${target.split('@')[0]} de ${groupMetadata.subject}`));
            } catch (e) {
                log(chalk.red(`Error al expulsar a ${target}: ${e.message}`));
                await sock.sendMessage(chat, { text: `❌ Error al kickear a @${target.split('@')[0]}. Asegúrate de que no es un administrador.` });
            }
        }
    });

    // Manejador de errores para evitar que el bot se detenga inesperadamente
    process.on('unhandledRejection', (err) => {
        log(chalk.red(`Error no manejado: ${err.message}`));
    });
}

// Iniciar bot
startBot();