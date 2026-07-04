/**
 * Transport-agnostic messaging interface.
 *
 * Phase 1 ships a Baileys implementation (reads a WhatsApp group via a linked
 * device + pairing-code login). The interface exists so a WhatsApp Cloud API
 * provider can be dropped in later without changing the core/intent code.
 */

export type ConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'pairing'
  | 'connected'
  | 'disconnected'
  | 'logged_out';

/** A normalized inbound message, independent of transport. */
export interface InboundMessage {
  /** Raw chat JID the message came from (group or DM). */
  chatId: string;
  /** True if this chat is a group. */
  isGroup: boolean;
  /** Group subject/name when known. */
  groupName?: string;
  /** Sender phone number, digits only (no @s.whatsapp.net). */
  senderPhone: string;
  /** Best-effort display name of the sender. */
  senderName: string;
  /** Plain text content (caption text included). */
  text: string;
  /** True if the message was sent by the linked account itself. */
  fromMe: boolean;
}

export interface ProviderState {
  status: ConnectionStatus;
  /** 8-digit pairing code to type on the phone, when in 'pairing'. */
  pairingCode?: string;
  /** Data-URL QR image, as a fallback to the pairing code. */
  qrDataUrl?: string;
  /** Last human-readable status detail. */
  detail?: string;
}

export type InboundHandler = (msg: InboundMessage) => void | Promise<void>;

export interface IMessagingProvider {
  readonly name: string;

  /** Begin connecting. If a phone number is provided, request a pairing code. */
  connect(opts?: { phoneNumber?: string }): Promise<void>;

  /** Send a plain text reply to a chat. */
  sendText(chatId: string, text: string): Promise<void>;

  /** Resolve a group's JID by its subject/name (for proactive sends). */
  resolveGroupJid?(name: string): Promise<string | null>;

  /** Register the handler invoked for each inbound message. */
  onMessage(handler: InboundHandler): void;

  /** Current connection state (for the setup UI). */
  getState(): ProviderState;

  /** Disconnect without clearing the session. */
  disconnect(): Promise<void>;
}
