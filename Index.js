import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} from '@whiskeysockets/baileys';
import P from 'pino';
import qrcode from 'qrcode-terminal';
import chalk from 'chalk';
import fs from 'fs';

// --- Configuración ---
const SESSION_PATH = "auth_info";
const LOG_FILE = "./logs.txt";

// --- Sistema de Logs ---
function log(message) {
    const timestamp = new Date().toLocaleString();
    const fullMessage = `[${timestamp}] ${message}\n`;
    console.log(chalk.green(fullMessage));
    fs.appendFileSync(LOG_FILE, fullMessage);
}

// --- Función Principal ---
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

    // Manejador de mensajes simple para demostrar que funciona
    sock.ev.on("messages.upsert", async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message) return;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;

        if (text === ".hola") {
            await sock.sendMessage(msg.key.remoteJid, { text: "¡Hola! Estoy en línea y funcionando." });
        }
    });

    // Manejador de errores para evitar que el bot se detenga inesperadamente
    process.on('unhandledRejection', (err) => {
        log(chalk.red(`Error no manejado: ${err.message}`));
    });
}

// Iniciar bot
startBot();