"use client";

import { useRef } from "react";
import { useEmojiAutocomplete, EmojiAutocompleteDropdown } from "@/components/EmojiAutocomplete";

/**
 * Single-line text input with `:emoji:` autocomplete, for profile fields and
 * other short inputs.
 */
export function EmojiInput({
  value,
  onChange,
  placeholder,
  ariaLabel,
  maxLength,
  style,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  maxLength?: number;
  style?: React.CSSProperties;
  className?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const auto = useEmojiAutocomplete(value, onChange, ref);

  return (
    <div style={{ position: "relative", ...style }}>
      <input
        type="text"
        ref={ref}
        className={className}
        style={{ width: "100%", boxSizing: "border-box" }}
        maxLength={maxLength}
        value={value}
        onChange={auto.onChange}
        onKeyDown={auto.onKeyDown}
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