// SPDX-License-Identifier: Apache-2.0
import { useState, useCallback } from "react";

type MentionType = "file" | "symbol" | "web" | "kb" | null;

interface UseContextMentionReturn {
  isOpen: boolean;
  query: string;
  mentionType: MentionType;
  /** Bumps when Enter asks the picker to take its highlighted row. */
  commitRequest: number;
  selectedIndex: number;
  setSelectedIndex: (i: number) => void;
  openPicker: () => void;
  closePicker: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean;
  onTextareaChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
}

const AT_RE = /@([^@\s]*)$/;

function parseMentionType(raw: string): { type: MentionType; tail: string } {
  if (raw.startsWith("file:")) return { type: "file", tail: raw.slice(5) };
  if (raw.startsWith("symbol:")) return { type: "symbol", tail: raw.slice(7) };
  if (raw.startsWith("web:")) return { type: "web", tail: raw.slice(4) };
  if (raw.startsWith("kb:")) return { type: "kb", tail: raw.slice(3) };
  return { type: null, tail: raw };
}

export function useContextMention(): UseContextMentionReturn {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [mentionType, setMentionType] = useState<MentionType>(null);
  const [commitRequest, setCommitRequest] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const closePicker = useCallback(() => {
    setIsOpen(false);
    setQuery("");
    setMentionType(null);
    setSelectedIndex(0);
  }, []);

  const openPicker = useCallback(() => {
    setIsOpen(true);
    setSelectedIndex(0);
  }, []);

  const onTextareaChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const val = e.target.value;
      const cursor = e.target.selectionStart ?? val.length;

      const textToCursor = val.slice(0, cursor);
      const match = AT_RE.exec(textToCursor);

      if (match) {
        const { type, tail } = parseMentionType(match[1]);
        setQuery(tail);
        setMentionType(type);
        setSelectedIndex(0);
        if (!isOpen) openPicker();
      } else {
        if (isOpen) closePicker();
      }
    },
    [isOpen, openPicker, closePicker],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!isOpen) return false;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => i + 1);
        return true;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(0, i - 1));
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closePicker();
        return true;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        setCommitRequest((n) => n + 1);
        return true;
      }
      return false;
    },
    [isOpen, closePicker],
  );

  return {
    isOpen,
    query,
    mentionType,
    commitRequest,
    selectedIndex,
    setSelectedIndex,
    openPicker,
    closePicker,
    onKeyDown,
    onTextareaChange,
  };
}
