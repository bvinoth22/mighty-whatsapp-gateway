import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidGroup,
  type WASocket,
} from 'baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import { logger } from '../../config/logger.js';
import type {
  IMessagingProvider,
  InboundHandler,
  InboundMessage,
  ProviderState,
} from '../IMessagingProvider.js';
import { createSessionStore, type SessionStore } from './sessionStore.js';
import { useSessionAuthState } from './useSessionAuthState.js';

export interface BaileysOptions {
  accountId: string;
  targetGroupName?: string;
  targetGroupJid?: string;
}

export class BaileysProvider implements IMessagingProvider {
  readonly name = 'baileys';

  private sock: WASocket | null = null;
  private store: SessionStore;
  private handler: InboundHandler | null = null;
  private state: ProviderState = { status: 'idle' };
  private lastPhone?: string;
  private pairingRequested = false;
  // Monotonic connection generation. Only the newest socket's events are acted
  // on; stale sockets (superseded by a newer connect) are ignored. This prevents
  // competing sockets from racing and getting killed with a spurious 401.
  private epoch = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private groupNameCache = new Map<string, string>();
  // IDs of messages we sent, so we never react to our own replies (echo loop).
  private sentIds = new Set<string>();
  // The bot's own phone (digits), used to resolve self-sent messages whose
  // participant shows up as a privacy LID rather than the real number.
  private botPhone?: string;

  constructor(private opts: BaileysOptions) {
    this.store = createSessionStore();
  }

  getState(): ProviderState {
    return this.state;
  }

  onMessage(handler: InboundHandler): void {
    this.handler = handler;
  }

  async connect(opts?: { phoneNumber?: string }): Promise<void> {
    if (opts?.phoneNumber) this.lastPhone = opts.phoneNumber.replace(/\D/g, '');
    this.pairingRequested = false;
    this.state = { status: 'connecting', detail: 'Starting WhatsApp connection…' };

    // Supersede any prior/pending connection: bump the generation and cancel a
    // scheduled auto-reconnect so it can't race with this fresh attempt.
    const myEpoch = ++this.epoch;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    // Tear down any previous socket so we never run competing pairing streams.
    if (this.sock) {
      try {
        this.sock.ev.removeAllListeners('connection.update');
        this.sock.ev.removeAllListeners('creds.update');
        this.sock.ev.removeAllListeners('messages.upsert');
        this.sock.end(undefined);
      } catch {
        /* ignore */
      }
      this.sock = null;
    }

    const { state, saveCreds } = await useSessionAuthState(this.store, this.opts.accountId);
    const { version } = await fetchLatestBaileysVersion();

    const usePairingCode = Boolean(this.lastPhone) && !state.creds.registered;

    logger.info({ waVersion: version, usePairingCode, phone: this.lastPhone }, 'starting socket');

    const sock = makeWASocket({
      version,
      auth: state,
      // QR is only printed when we are NOT using a pairing code.
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }) as any,
      // A standard browser identity is required for the pairing-code flow to
      // complete reliably; a custom platform name can break linking.
      browser: Browsers.ubuntu('Chrome'),
      syncFullHistory: false,
    });
    this.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      // Ignore events from a socket that a newer connect() has superseded.
      if (myEpoch !== this.epoch) return;
      const { connection, lastDisconnect, qr } = update;
      logger.info(
        {
          connection,
          hasQr: Boolean(qr),
          statusCode: (lastDisconnect?.error as any)?.output?.statusCode,
        },
        'connection.update',
      );

      if (qr && !usePairingCode) {
        this.state = {
          status: 'pairing',
          qrDataUrl: await QRCode.toDataURL(qr),
          detail: 'Scan the QR code, or set BOT_PHONE_NUMBER to use a pairing code instead.',
        };
      }

      // Request the pairing code only once the socket is ready (first qr event).
      // Requesting earlier races the handshake and WhatsApp rejects it with 401.
      if (qr && usePairingCode && !this.pairingRequested) {
        this.pairingRequested = true;
        try {
          const code = await sock.requestPairingCode(this.lastPhone!);
          const pretty = code?.match(/.{1,4}/g)?.join('-') ?? code;
          this.state = {
            status: 'pairing',
            pairingCode: pretty,
            detail:
              'On your phone: WhatsApp → Linked Devices → Link with phone number → enter this code.',
          };
          logger.info({ code: pretty }, 'Pairing code generated');
        } catch (err: any) {
          this.state = { status: 'disconnected', detail: `Pairing failed: ${err.message}` };
          logger.error({ err: err.message }, 'requestPairingCode failed');
        }
      }

      if (connection === 'open') {
        this.state = { status: 'connected', detail: 'Connected to WhatsApp.' };
        const me = sock.user?.id ?? '';
        this.botPhone = me.split('@')[0].split(':')[0].replace(/\D/g, '') || undefined;
        logger.info({ botPhone: this.botPhone, user: sock.user }, '✅ WhatsApp connected');
      } else if (connection === 'close') {
        const code = (lastDisconnect?.error as any)?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        this.state = {
          status: loggedOut ? 'logged_out' : 'disconnected',
          detail: loggedOut
            ? 'Logged out. Re-link the account to continue.'
            : 'Connection closed, reconnecting…',
        };
        logger.warn({ code, loggedOut }, 'WhatsApp connection closed');
        if (loggedOut) {
          await this.store.clear(this.opts.accountId);
        } else if (myEpoch === this.epoch) {
          // Only the current socket may schedule a reconnect, and only one.
          if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
          this.reconnectTimer = setTimeout(
            () => this.connect({ phoneNumber: this.lastPhone }),
            4000,
          );
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (myEpoch !== this.epoch) return; // stale socket
      logger.info({ type, count: messages.length }, 'messages.upsert');
      if (type !== 'notify' || !this.handler) return;
      for (const msg of messages) {
        // Skip echoes of our own outgoing replies.
        if (msg.key?.id && this.sentIds.has(msg.key.id)) continue;
        const normalized = await this.normalize(msg);
        if (normalized) {
          logger.info(
            {
              isGroup: normalized.isGroup,
              groupName: normalized.groupName,
              sender: normalized.senderPhone,
              participantLid: msg.key?.participantLid || msg.key?.participant,
              participantPn: msg.key?.participantPn,
              fromMe: normalized.fromMe,
              text: normalized.text.slice(0, 60),
            },
            'inbound message',
          );
          await this.handler(normalized);
        }
      }
    });

    // Note: the pairing code is requested in the connection.update handler on the
    // first qr event, once the socket handshake is ready (see above).
  }

  async sendText(chatId: string, text: string): Promise<void> {
    if (!this.sock) throw new Error('Not connected');
    const sent = await this.sock.sendMessage(chatId, { text });
    const id = sent?.key?.id;
    if (id) {
      this.sentIds.add(id);
      // Keep the set bounded.
      if (this.sentIds.size > 200) {
        this.sentIds.delete(this.sentIds.values().next().value as string);
      }
    }
  }

  /** Find a joined group's JID by matching its subject (case/separator-insensitive). */
  async resolveGroupJid(name: string): Promise<string | null> {
    if (!this.sock || !name) return null;
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const target = norm(name);
    try {
      const groups = await this.sock.groupFetchAllParticipating();
      for (const [jid, meta] of Object.entries(groups)) {
        const subject = (meta as { subject?: string }).subject ?? '';
        if (norm(subject) === target) {
          this.groupNameCache.set(jid, subject);
          return jid;
        }
      }
    } catch (err: any) {
      logger.warn({ err: err.message, name }, 'resolveGroupJid failed');
    }
    return null;
  }

  async disconnect(): Promise<void> {
    try {
      await this.sock?.logout();
    } catch {
      /* ignore */
    }
    this.sock = null;
    this.state = { status: 'disconnected', detail: 'Disconnected.' };
  }

  /** Convert a raw Baileys message into the transport-agnostic shape. */
  private async normalize(msg: any): Promise<InboundMessage | null> {
    const chatId: string | undefined = msg.key?.remoteJid;
    if (!chatId) return null;

    const text: string =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.imageMessage?.caption ||
      msg.message?.videoMessage?.caption ||
      '';
    if (!text) return null;

    const isGroup = isJidGroup(chatId) ?? false;
    let groupName: string | undefined;
    if (isGroup && this.sock) {
      groupName = this.groupNameCache.get(chatId);
      if (!groupName) {
        try {
          const meta = await this.sock.groupMetadata(chatId);
          groupName = meta.subject;
          this.groupNameCache.set(chatId, groupName);
        } catch {
          /* metadata may be unavailable */
        }
      }
    }

    const fromMe = Boolean(msg.key?.fromMe);
    // WhatsApp now addresses group participants by a privacy LID (…@lid) rather
    // than the phone number. The real phone JID is carried alongside it in
    // participantPn / senderPn — always prefer that so tenant resolution works.
    const key = msg.key ?? {};
    const senderJid: string =
      key.participantPn ||
      key.senderPn ||
      key.participant ||
      key.remoteJid ||
      '';
    // For self-sent messages the participant may still be a LID, so fall back to
    // the bot's own number (which is the sender in that case).
    const senderPhone =
      fromMe && this.botPhone ? this.botPhone : senderJid.split('@')[0].split(':')[0];

    return {
      chatId,
      isGroup,
      groupName,
      senderPhone,
      senderName: msg.pushName || senderPhone,
      text,
      fromMe,
    };
  }
}
