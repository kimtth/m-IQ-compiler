import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { Lock, Pencil, RefreshCw } from "lucide-react";
import {
  isTenantIdentifier,
  type AuthStatus,
  type CopilotAuthStatus,
  type TenantSummary,
} from "@iq/shared";
import { call, subscribe } from "./bridge.js";

/**
 * The pre-app gate.
 *
 * Both connections are required because Foundry models, Work IQ and Microsoft
 * 365 are core to the product, not optional extras: the app does not open until
 * Azure and GitHub Copilot are both green. Order is not enforced — either
 * button may be used first — and each connection carries its own status dot and
 * line so a failure names the thing that failed rather than surfacing later as
 * a broken turn.
 */

interface SignInProps {
  auth: AuthStatus;
  copilot: CopilotAuthStatus;
  onContinue: () => void;
  onError: (problem: unknown) => void;
}

/** How the two lines read while nothing has happened yet. */
const NOT_CONNECTED = "Not connected — Not signed in yet.";

export function SignIn({ auth, copilot, onContinue, onError }: SignInProps): JSX.Element {
  // Props seed the initial state, but the device flow and the interactive Azure
  // browser both resolve out of band, so we keep polling until both are green.
  const [azure, setAzure] = useState<AuthStatus>(auth);
  const [runtime, setRuntime] = useState<CopilotAuthStatus>(copilot);
  const [tenants, setTenants] = useState<TenantSummary[]>([]);

  const [tenantField, setTenantField] = useState("");
  const [editingTenant, setEditingTenant] = useState(false);
  const [tenantError, setTenantError] = useState("");

  const [azureBusy, setAzureBusy] = useState(false);
  const [copilotBusy, setCopilotBusy] = useState(false);

  const azureReady = azure.state === "signed_in";
  const copilotReady = runtime.state === "signed_in";
  const bothReady = azureReady && copilotReady;

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setAzure(await call("auth:status"));
      setRuntime(await call("auth:copilotStatus"));
    } catch (problem) {
      onError(problem);
    }
  }, [onError]);

  useEffect(() => {
    void refresh();
    // The main process re-pushes auth state; mirror it so the gate reacts the
    // moment a browser flow or a device-code flow completes.
    return subscribe<AuthStatus>("auth:status", (next) => setAzure(next));
  }, [refresh]);

  // Poll only while something is still pending, so a completed device flow or a
  // returning interactive sign-in flips the gate without the user re-clicking.
  useEffect(() => {
    if (bothReady) return;
    const timer = window.setInterval(() => void refresh(), 4_000);
    return () => window.clearInterval(timer);
  }, [bothReady, refresh]);

  // The tenant preference is read-only by default; seed it from what the next
  // sign-in will target so the common case is a single click.
  useEffect(() => {
    call("auth:tenant")
      .then((value) => setTenantField(value.tenantId ?? ""))
      .catch(() => undefined);
  }, []);

  // Once an account is known, offer the tenants it can reach so switching never
  // means pasting a GUID a second time.
  useEffect(() => {
    if (azure.state !== "signed_in") return;
    call("auth:tenants")
      .then(setTenants)
      .catch(() => undefined);
  }, [azure.state]);

  const tenantName = useMemo(() => {
    if (azure.state !== "signed_in") return "";
    const match = tenants.find((entry) => entry.tenantId === azure.account.tenantId);
    return match ? match.displayName : azure.account.tenantId;
  }, [azure, tenants]);

  const azureLine = azureStatusLine(azure, tenantName);
  const copilotLine = copilotStatusLine(runtime);
  const azureFault = azureFailure(azure);

  const signInAzure = async (): Promise<void> => {
    const raw = tenantField.trim();
    // A malformed tenant is a field error caught before sign-in, not an opaque
    // AADSTS failure three seconds into an interactive browser flow.
    if (raw !== "" && !isTenantIdentifier(raw)) {
      setTenantError("Enter a tenant GUID or a domain such as contoso.onmicrosoft.com.");
      return;
    }
    setTenantError("");
    setAzureBusy(true);
    try {
      await call("auth:signIn", { tenantId: raw === "" ? null : raw });
      setEditingTenant(false);
      await refresh();
    } catch (problem) {
      onError(problem);
    } finally {
      setAzureBusy(false);
    }
  };

  const connectCopilot = async (): Promise<void> => {
    // The SDK owns the device-code flow and the credential store; the app only
    // reads the result, so "connect" here means start the runtime and re-read.
    setCopilotBusy(true);
    try {
      setRuntime(await call("auth:copilotStatus"));
    } catch (problem) {
      onError(problem);
    } finally {
      setCopilotBusy(false);
    }
  };

  return (
    <div className="gate">
      <div className="signin-card">
        <div className="row" style={{ justifyContent: "center" }}>
          <Lock size={24} aria-hidden />
        </div>
        <h2 style={{ textAlign: "center" }}>Connect IQ Compiler</h2>
        <p className="muted" style={{ textAlign: "center" }}>
          Signing in to Microsoft acquires an Azure token, and GitHub Copilot connects the agent
          runtime. The Foundry connection is verified inside the app once you are in.
        </p>

        <div className="field-row">
          <label>Tenant ID</label>
          {editingTenant ? (
            <input
              className="mono"
              autoFocus
              value={tenantField}
              placeholder="blank = your home tenant"
              onChange={(event) => setTenantField(event.target.value)}
              onBlur={() => setEditingTenant(false)}
            />
          ) : (
            <div className="row">
              <span className="mono">{tenantField || "Home tenant"}</span>
              <button
                className="icon"
                title="Edit tenant"
                aria-label="Edit tenant"
                onClick={() => setEditingTenant(true)}
              >
                <Pencil size={16} aria-hidden />
              </button>
            </div>
          )}
        </div>
        {tenantError !== "" && <div className="status-line bad">{tenantError}</div>}

        {tenants.length > 0 && (
          <div className="field-row">
            <label>Known tenants</label>
            <select
              value={tenantField}
              onChange={(event) => {
                setTenantField(event.target.value);
                setTenantError("");
              }}
            >
              <option value="">Home tenant</option>
              {tenants.map((entry) => (
                <option key={entry.tenantId} value={entry.tenantId}>
                  {entry.displayName} · {entry.defaultDomain} · {entry.tenantId}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="connection-row">
          <button
            className="primary"
            style={{ width: "100%" }}
            disabled={azureBusy || azure.state === "signing_in"}
            onClick={() => void signInAzure()}
          >
            Sign in to Microsoft (Azure)
          </button>
          <div className="status-line">
            <span className={`status-dot ${azureReady ? "ok" : azureFault ? "bad" : "warn"}`} />
            <span>{azureLine}</span>
          </div>
          {azureFault && <div className="muted">{azureFault.nextStep}</div>}
        </div>

        <div className="connection-row">
          <button
            style={{ width: "100%" }}
            disabled={copilotBusy}
            onClick={() => void connectCopilot()}
          >
            <RefreshCw size={16} aria-hidden /> Sign in to GitHub Copilot
          </button>
          <div className="status-line">
            <span className={`status-dot ${copilotReady ? "ok" : copilotFailure(runtime) ? "bad" : "warn"}`} />
            <span>{copilotLine}</span>
          </div>
          {copilotFailure(runtime) && <div className="muted">{copilotFailure(runtime)}</div>}
        </div>

        <button
          className="primary"
          style={{ width: "100%", marginTop: 8 }}
          disabled={!bothReady}
          onClick={onContinue}
        >
          Continue
        </button>

        <p className="muted" style={{ fontSize: 12 }}>
          Microsoft sign-in uses the Azure CLI identity — no app registration, no client secret.
          GitHub Copilot signs in through its own device flow and stores its own credential; IQ
          Compiler never holds a GitHub token.
        </p>
      </div>
    </div>
  );
}

/** Human status line for the Azure connection, green only when signed in. */
function azureStatusLine(auth: AuthStatus, tenantName: string): string {
  switch (auth.state) {
    case "signed_in":
      return `Connected — ${auth.account.username} · ${tenantName}`;
    case "signing_in":
      return "Signing in — complete the sign-in in your browser…";
    case "cli_missing":
      return `Not connected — ${auth.message}`;
    case "error":
      return `Not connected — ${auth.message}`;
    default:
      return NOT_CONNECTED;
  }
}

interface Fault {
  nextStep: string;
  offerPicker: boolean;
}

/**
 * Turn an Azure failure into the one thing the user should do next.
 *
 * AADSTS50020 is the case worth naming: it reads like a permission problem but
 * means the account is not a member of the requested tenant, and the fix is the
 * tenant picker rather than a support ticket.
 */
function azureFailure(auth: AuthStatus): Fault | null {
  if (auth.state === "cli_missing") {
    return {
      nextStep: "Install the Azure CLI and make sure `az` is on your PATH, then retry.",
      offerPicker: false,
    };
  }
  if (auth.state !== "error") return null;
  const message = auth.message;
  if (message.includes("AADSTS50020")) {
    return {
      nextStep: "This account is not a member of that tenant. Pick a tenant you can reach and retry.",
      offerPicker: true,
    };
  }
  if (/consent|AADSTS65001|conditional access|AADSTS53/i.test(message)) {
    return { nextStep: "Consent or a conditional-access step is required. Retry to complete it.", offerPicker: false };
  }
  if (/expired|AADSTS700082|AADSTS50173/i.test(message)) {
    return { nextStep: "The session expired. Sign in again to refresh the token.", offerPicker: false };
  }
  if (/cancel/i.test(message)) {
    return { nextStep: "Sign-in was cancelled. Retry when you are ready.", offerPicker: false };
  }
  return { nextStep: message, offerPicker: false };
}

function copilotStatusLine(status: CopilotAuthStatus): string {
  switch (status.state) {
    case "signed_in":
      return `Connected — ${status.login ?? "signed in"}${status.host ? ` · ${status.host}` : ""}`;
    case "unknown":
      return "Not connected — starting the agent runtime…";
    case "signed_out":
      return `Not connected — ${status.message}`;
    case "error":
      return `Not connected — ${status.message}`;
    default:
      return NOT_CONNECTED;
  }
}

/** Next step for a Copilot connection that is not green, or null when it is. */
function copilotFailure(status: CopilotAuthStatus): string | null {
  if (status.state === "signed_in" || status.state === "unknown") return null;
  const message = status.state === "error" || status.state === "signed_out" ? status.message : "";
  if (/GITHUB_TOKEN|GH_TOKEN/i.test(message)) {
    return "A stale GITHUB_TOKEN is set in the environment. Unset it so the runtime uses your Copilot credential.";
  }
  if (/entitlement|not entitled|subscription/i.test(message)) {
    return "This account has no Copilot entitlement. Sign in with a Copilot-enabled account.";
  }
  if (/expired/i.test(message)) {
    return "The device-code flow expired. Start it again from the Copilot CLI and refresh.";
  }
  if (/pending|device/i.test(message)) {
    return "A device-code sign-in is pending. Complete it in your browser, then refresh.";
  }
  return message || "Sign in with the Copilot CLI device flow, then refresh.";
}
