"use client";

import { useRef } from "react";
import { useEmojiAutocomplete, EmojiAutocompleteDropdown } from "@/components/EmojiAutocomplete";

/**
 * Multi-line textarea with `:emoji:` autocomplete, for bios, policies and
 * other longer plain-text inputs.
 */
export function EmojiTextarea({
  value,
  onChange,
  placeholder,
  ariaLabel,
  maxLength,
  minHeight,
  style,
  containerStyle,
  className,
  onKeyDown,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  maxLength?: number;
  minHeight?: number;
  style?: React.CSSProperties;
  containerStyle?: React.CSSProperties;
  className?: string;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const auto = useEmojiAutocomplete(value, onChange, ref);

  return (
    <div style={{ position: "relative", ...containerStyle }}>
      <textarea
        ref={ref}
        className={className}
        style={{ ...style, width: "100%", boxSizing: "border-box", fontFamily: "inherit", resize: "none", minHeight }}
        maxLength={maxLength}
        value={value}
        onChange={auto.onChange}
        onKeyDown={(e) => { auto.onKeyDown(e); onKeyDown?.(e); }}
        placeholder={placeholder}
        aria-label={ariaLabel}
      />
      <EmojiAutocompleteDropdown
        suggestions={auto.suggestions}
        activeIndex={auto.activeIndex}
        onSelect={auto.select}
      />
    </div>
  );
}