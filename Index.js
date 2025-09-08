import * as baileys from "@whiskeysockets/baileys";
import P from "pino";
import qrcode from "qrcode-terminal";
import chalk from "chalk";
import fs from "fs";
import path from "path";

// --- Configuración y Constantes ---
const SESSION_PATH = "auth_info";
const LOG_FILE = "./logs.txt";
const PREFIX = ".";
const warnings = {}; // { [groupJid]: { [userJid]: count } }

// --- Sistema de Logs ---
function log(message) {
    const timestamp = new Date().toLocaleString();
    const fullMessage = `[${timestamp}] ${message}\n`;
    console.log(chalk.green(fullMessage));
    fs.appendFileSync(LOG_FILE, fullMessage);
}

// --- Funciones de Moderación ---
const isUserAdmin = async (sock, groupId, userId) => {
    try {
        const groupMetadata = await sock.groupMetadata(groupId);
        const user = groupMetadata.participants.find(p => p.id === userId);
        return user && (user.admin === 'superadmin' || user.admin === 'admin');
    } catch (e) {
        log(chalk.red(`Error al verificar si el usuario es admin: ${e.message}`));
        return false;
    }
};

// --- Función Principal del Bot ---
async function startBot() {
    log("Iniciando el bot...");

    // Verifica y crea la carpeta de sesión si no existe
    const { state, saveCreds } = await baileys.useMultiFileAuthState(SESSION_PATH);
    const { version } = await baileys.fetchLatestBaileysVersion();

    const sock = baileys.default({
        version,
        printQRInTerminal: true,
        auth: state,
        logger: P({ level: "silent" }),
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("messages.upsert", async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.participant || msg.key.remoteJid;
        const chat = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

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
        const senderIsAdmin = await isUserAdmin(sock, chat, sender);

        // --- Anti-Link ---
        const linkRegex = /(https?:\/\/[^\s]+)/gi;
        if (text && linkRegex.test(text)) {
            if (senderIsAdmin) return; // Los admins pueden enviar enlaces

            if (!warnings[chat]) warnings[chat] = {};
            if (!warnings[chat][sender]) warnings[chat][sender] = 0;

            warnings[chat][sender]++;
            const warnCount = warnings[chat][sender];

            if (warnCount === 1) {
                await sock.sendMessage(chat, { text: `⚠️ Advertencia 1/3: No se permiten links.` }, { quoted: msg });
            } else if (warnCount === 2) {
                await sock.sendMessage(chat, { text: `⚠️ Advertencia 2/3: Tu mensaje será eliminado.` }, { quoted: msg });
                await sock.sendMessage(chat, { delete: msg.key });
            } else if (warnCount >= 3) {
                await sock.sendMessage(chat, { delete: msg.key });
                if (botIsAdmin) {
                    await sock.groupParticipantsUpdate(chat, [sender], "remove");
                    await sock.sendMessage(chat, { text: `❌ @${sender.split('@')[0]} eliminado por tercera infracción.` });
                    log(chalk.yellow(`[ANTI-LINK] ${sender} expulsado de ${groupMetadata.subject}`));
                } else {
                    log(chalk.red(`[ANTI-LINK] No se pudo expulsar a ${sender} en ${groupMetadata.subject}, el bot no es admin.`));
                }
                warnings[chat][sender] = 0;
            }
        }

        // --- Comando .kick ---
        if (text && text.startsWith(PREFIX + 'kick')) {
            if (!senderIsAdmin) {
                await sock.sendMessage(chat, { text: "❌ Solo los administradores pueden usar este comando." }, { quoted: msg });
                return;
            }
            if (!botIsAdmin) {
                await sock.sendMessage(chat, { text: "❌ No puedo kickear, necesito ser admin." }, { quoted: msg });
                return;
            }
            
            const mentions = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
            if (mentions.length === 0) {
                await sock.sendMessage(chat, { text: "❌ Por favor, menciona a un usuario para expulsarlo." }, { quoted: msg });
                return;
            }

            const target = mentions[0];
            try {
                await sock.groupParticipantsUpdate(chat, [target], "remove");
                await sock.sendMessage(chat, { text: `✅ @${target.split('@')[0]} ha sido eliminado por un admin.` });
                log(chalk.green(`[COMANDO] ${sender} expulsó a ${target} de ${groupMetadata.subject}`));
            } catch (e) {
                log(chalk.red(`Error al expulsar a ${target}: ${e.message}`));
                await sock.sendMessage(chat, { text: `❌ Error al kickear a @${target.split('@')[0]}. Asegúrate de que no es un administrador.` });
            }
        }
    });

    sock.ev.on("connection.update", (update) => {
        const { connection } = update;
        if (connection === "close") {
            log(chalk.yellow("⚠️ Conexión cerrada, reconectando..."));
            startBot();
        } else if (connection === "open") {
            log(chalk.cyan("✅ Bot conectado correctamente."));
        }
    });
}

// Iniciar bot
startBot();