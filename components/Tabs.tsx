"use client";

import type { CSSProperties, ReactNode } from "react";

export interface TabItem<T extends string> {
  key: T;
  label: ReactNode;
  /** Optional trailing count (search results, profile counters). */
  count?: number;
}

interface TabsProps<T extends string> {
  tabs: TabItem<T>[];
  active: T;
  onChange: (key: T) => void;
  /**
   * Auto-width tabs in a horizontally scrollable row — profiles carry enough
   * tabs to overflow on mobile. Every other tab bar shares the row equally.
   */
  scroll?: boolean;
  style?: CSSProperties;
}

/**
 * The tab bar every section uses (explore, timelines, notifications, lists,
 * profiles, status detail). Sizing, font and selected state live in the `.tab`
 * class so they stay identical everywhere; `aria-selected` carries the state,
 * so the CSS (and assistive tech) needs nothing else.
 */
export function Tabs<T extends string>({ tabs, active, onChange, scroll = false, style }: TabsProps<T>) {
  return (
    <div
      role="tablist"
      className={scroll ? "tab-scroll" : undefined}
      style={{
        display: "flex",
        borderBottom: "1px solid var(--border)",
        overflowX: scroll ? "auto" : undefined,
        ...style,
      }}
    >
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          aria-selected={active === tab.key}
          className="tab"
          onClick={() => onChange(tab.key)}
          style={{ flex: scroll ? "0 0 auto" : 1 }}
        >
          {tab.label}
          {tab.count !== undefined && <span className="tab-count">{tab.count.toLocaleString()}</span>}
        </button>
      ))}
    </div>
  );
}
