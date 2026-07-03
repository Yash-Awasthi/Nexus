// SPDX-License-Identifier: Apache-2.0
import { useRef, useState, useCallback } from "react";

export type MentionType = "file" | "symbol" | "web" | null;

export interface AnchorPos {
  top: number;
  left: number;
}

export interface UseContextMentionReturn {
  isOpen: boolean;
  query: string;
  mentionType: MentionType;
  anchorPos: AnchorPos;
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
  return { type: null, tail: raw };
}

function getAnchorPos(ta: HTMLTextAreaElement): AnchorPos {
  const rect = ta.getBoundingClientRect();
  return { top: rect.bottom + 4, left: rect.left };
}

export function useContextMention(
  taRef: React.RefObject<HTMLTextAreaElement | null>,
): UseContextMentionReturn {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [mentionType, setMentionType] = useState<MentionType>(null);
  const [anchorPos, setAnchorPos] = useState<AnchorPos>({ top: 0, left: 0 });
  const [selectedIndex, setSelectedIndex] = useState(0);
  const valueRef = useRef("");

  const closePicker = useCallback(() => {
    setIsOpen(false);
    setQuery("");
    setMentionType(null);
    setSelectedIndex(0);
  }, []);

  const openPicker = useCallback(() => {
    setIsOpen(true);
    setSelectedIndex(0);
    if (taRef.current) {
      setAnchorPos(getAnchorPos(taRef.current));
    }
  }, [taRef]);

  const onTextareaChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const val = e.target.value;
      const cursor = e.target.selectionStart ?? val.length;
      valueRef.current = val;

      const textToCursor = val.slice(0, cursor);
      const match = AT_RE.exec(textToCursor);

      if (match) {
        const { type, tail } = parseMentionType(match[1]);
        setQuery(tail);
        setMentionType(type);
        setSelectedIndex(0);
        if (!isOpen) openPicker();
        else if (taRef.current) setAnchorPos(getAnchorPos(taRef.current));
      } else {
        if (isOpen) closePicker();
      }
    },
    [isOpen, openPicker, closePicker, taRef],
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
      if (e.key === "Enter") {
        e.preventDefault();
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
    anchorPos,
    selectedIndex,
    setSelectedIndex,
    openPicker,
    closePicker,
    onKeyDown,
    onTextareaChange,
  };
}
