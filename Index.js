// index.js
import * as baileys from "@whiskeysockets/baileys";
import P from "pino";

const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = baileys;

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState("auth_info");
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        printQRInTerminal: true,
        auth: state,
        logger: P({ level: "silent" }),
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("messages.upsert", async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
        const sender = msg.key.participant || msg.key.remoteJid;
        const chat = msg.key.remoteJid;

        if (!chat.endsWith("@g.us")) return; // Solo grupos

        const groupMetadata = await sock.groupMetadata(chat);
        const botAdmin = groupMetadata.participants.find(p => p.id.includes(sock.user.id.split(":")[0]))?.admin || false;
        const senderAdmin = groupMetadata.participants.find(p => p.id === sender)?.admin;

        if (!senderAdmin) return; // Solo admins pueden usar kick

        let target = null;

        // Kick por mencionar: .kick @numero, #kick @numero, .k @numero
        if (/^(\.kick|#kick|\.k)/i.test(text)) {
            const parts = text.split(" ");
            if (parts[1]) {
                target = parts[1].replace("@", "") + "@s.whatsapp.net";
            }
        }
        // Kick por mensaje que dice "kick usuario"
        else if (/^kick /i.test(text)) {
            const parts = text.split(" ");
            if (parts[1]) {
                target = parts[1] + "@s.whatsapp.net"; // Asume que usuario = número
            }
        }

        if (!target) return;

        if (!botAdmin) {
            await sock.sendMessage(chat, { text: "❌ No puedo kickear, necesito ser admin." });
            return;
        }

        try {
            await sock.groupParticipantsUpdate(chat, [target], "remove");
            await sock.sendMessage(chat, { text: `✅ ${target} ha sido eliminado por admin.` });
        } catch (e) {
            await sock.sendMessage(chat, { text: `❌ Error al kickear ${target}.` });
        }
    });

    sock.ev.on("connection.update", (update) => {
        const { connection } = update;
        if (connection === "close") {
            console.log("⚠️ Conexión cerrada, reconectando...");
            startBot();
        } else if (connection === "open") {
            console.log("✅ Bot conectado correctamente y listo para usar .kick");
        }
    });
}

// Iniciar automáticamente
startBot();