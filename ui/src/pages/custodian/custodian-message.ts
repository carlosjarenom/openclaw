import type { MessageGroup } from "../../lib/chat/chat-types.ts";
import type { CustodianStructuredQuestion } from "./structured-question.ts";

export type CustodianMessage = {
  id: number;
  role: "assistant" | "user";
  text: string;
  at: number;
  question: CustodianStructuredQuestion | null;
};

export function toMessageGroup(message: CustodianMessage): MessageGroup {
  const key = `msg-${message.id}`;
  return {
    kind: "group",
    key,
    role: message.role,
    messages: [{ message: { role: message.role, content: message.text }, key }],
    timestamp: message.at,
    isStreaming: false,
  };
}
