"use client";

import { createContext, useContext } from "react";

/**
 * Instance brand name (INSTANCE_TITLE), provided by the root layout from the
 * server env. Falls back to the project default so components/tests that render
 * outside the provider keep working.
 */
const InstanceTitleContext = createContext("CF ActivityPub");

export function InstanceTitleProvider({
  title,
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <InstanceTitleContext.Provider value={title || "CF ActivityPub"}>
      {children}
    </InstanceTitleContext.Provider>
  );
}

export function useInstanceTitle(): string {
  return useContext(InstanceTitleContext);
}
