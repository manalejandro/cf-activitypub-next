"use client";

import { useEffect } from "react";
import { getToken } from "@/lib/client-api";

declare global {
  interface Window {
    SwaggerUIBundle?: {
      (config: Record<string, unknown>): void;
      presets: { apis: unknown };
    };
    SwaggerUIStandalonePreset?: unknown;
  }
}

export default function DocsPage() {
  useEffect(() => {
    const init = () => {
      const bundle = window.SwaggerUIBundle;
      if (!bundle) return;
      // If the user is logged into the web app, pre-authorize Swagger UI with
      // their session token so the Authorize button shows "Authorized" and Try
      // It Out requests carry the Authorization header automatically.
      const token = getToken();
      bundle({
        url: "/api/docs/openapi.json",
        dom_id: "#swagger-ui",
        deepLinking: true,
        displayRequestDuration: true,
        persistAuthorization: true,
        tryItOutEnabled: true,
        authorizations: token
          ? { bearerAuth: { value: token, schema: { type: "http", scheme: "bearer" } } }
          : undefined,
        presets: [bundle.presets.apis, window.SwaggerUIStandalonePreset],
        layout: "StandaloneLayout",
      });
    };

    if (window.SwaggerUIBundle) {
      init();
      return;
    }

    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/swagger-ui/swagger-ui.css";
    document.head.appendChild(link);

    const bundleScript = document.createElement("script");
    bundleScript.src = "/swagger-ui/swagger-ui-bundle.js";
    bundleScript.onload = () => {
      const presetScript = document.createElement("script");
      presetScript.src = "/swagger-ui/swagger-ui-standalone-preset.js";
      presetScript.onload = init;
      document.body.appendChild(presetScript);
    };
    document.body.appendChild(bundleScript);
  }, []);

  return (
    <div className="force-light" style={{ background: "var(--bg)", minHeight: "100vh" }}>
      <div id="swagger-ui" style={{ minHeight: "100vh" }} />
    </div>
  );
}