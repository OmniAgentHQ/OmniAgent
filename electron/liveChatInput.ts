export type ChatFollowUp = {
  text: string;
  attachments: Array<{ path: string; name: string; mimeType: string }>;
};

export class LiveChatInput {
  accepting = true;
  private pending: ChatFollowUp[] = [];
  private sender?: (message: ChatFollowUp) => Promise<boolean>;
  private flight?: Promise<void>;
  private failure?: unknown;
  private resolveFinished!: () => void;
  readonly finished = new Promise<void>((resolve) => { this.resolveFinished = resolve; });

  push(message: ChatFollowUp) {
    if (!this.accepting) throw new Error('This chat request has finished.');
    this.pending.push(message);
    this.pump();
  }

  bind(sender: (message: ChatFollowUp) => Promise<boolean>) {
    this.sender = sender;
    this.pump();
  }

  unbind() { this.sender = undefined; }
  seal() { this.accepting = false; this.unbind(); }
  finish() { this.seal(); this.resolveFinished(); }

  async settle() {
    await this.flight;
    if (this.failure) throw this.failure;
  }

  takePending() { return this.pending.splice(0); }

  private pump() {
    if (this.flight || !this.sender || !this.pending.length) return;
    this.flight = (async () => {
      while (this.sender && this.pending.length) {
        const sender = this.sender;
        const message = this.pending[0];
        if (!await sender(message)) {
          if (this.sender === sender) this.unbind();
          break;
        }
        this.pending.shift();
      }
    })().catch((error) => { this.failure = error; this.unbind(); }).finally(() => {
      this.flight = undefined;
      this.pump();
    });
  }
}

export function followUpPrompt(messages: ChatFollowUp[]) {
  return messages.map((message) => [message.text,
    ...message.attachments.map((file) => `Attached file "${file.name}" is available at: ${file.path}`)
  ].filter(Boolean).join('\n')).join('\n\n');
}
