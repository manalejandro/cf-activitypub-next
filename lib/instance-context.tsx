"use client";

import { createContext, useContext } from "react";

/**
 * Instance brand (INSTANCE_TITLE) and version, provided by the root layout
 * from the server env. Passing the version here avoids every page re-fetching
 * `/api/v1/instance` just to show it in a footer or sidebar caption. Falls
 * back to the project defaults so components/tests rendered outside the
 * provider keep working.
 */
interface InstanceBrand {
  title: string;
  version: string;
}

const InstanceContext = createContext<InstanceBrand>({
  title: "CF ActivityPub",
  version: "",
});

export function InstanceTitleProvider({
  title,
  version,
  children,
}: {
  title?: string;
  version?: string;
  children: React.ReactNode;
}) {
  return (
    <InstanceContext.Provider value={{ title: title || "CF ActivityPub", version: version || "" }}>
      {children}
    </InstanceContext.Provider>
  );
}

export function useInstanceTitle(): string {
  return useContext(InstanceContext).title;
}

export function useInstanceVersion(): string {
  return useContext(InstanceContext).version;
}
