// Rental Deposit Escrow: browser app.
//
// - MetaMask (ethers v6 BrowserProvider) signs every transaction; the page never sees a private key.
// - Lease state is read straight from the contract (always current).
// - The lease list and the history come from the backend index (rebuilt from contract events).
// - Evidence files go through the backend, which returns the SHA-256 that is stored on-chain.
// - All dynamic text is inserted with textContent (see h()), never innerHTML, so chain data and file
//   names cannot inject markup.

(function () {
  "use strict";

  // -------------------------------------------------------------------------
  // constants
  // -------------------------------------------------------------------------
  const S = { Created: 0, Funded: 1, DeductionProposed: 2, Disputed: 3, Settled: 4, Cancelled: 5 };
  const STATUS_NAMES = ["Created", "Funded", "Deduction proposed", "Disputed", "Settled", "Cancelled"];
  const SETTLEMENT_NAMES = [
    "landlord returned the full deposit",
    "full refund after the landlord stayed silent",
    "tenant accepted the deduction",
    "deduction applied after the tenant stayed silent",
    "arbiter ruling",
  ];
  const STEPS = [
    ["Created", S.Created],
    ["Funded", S.Funded],
    ["Deduction proposed", S.DeductionProposed],
    ["Disputed", S.Disputed],
    ["Settled", S.Settled],
  ];
  const MIN_WINDOW = 60; // seconds, same as the contract
  const MAX_WINDOW = 90 * 24 * 3600;
  const UNITS = { minutes: 60, hours: 3600, days: 86400 };

  const ERROR_MESSAGES = {
    LeaseNotFound: "This lease does not exist.",
    NotLandlord: "Only the landlord of this lease can do this.",
    NotTenant: "Only the tenant of this lease can do this.",
    NotParty: "Only the landlord or the tenant can do this.",
    NotArbiter: "Only the platform arbiter can do this.",
    InvalidStatus: "This action is not available in the lease's current state.",
    ArbiterCannotBeParty: "The platform arbiter account cannot create leases. Switch to the landlord account.",
    InvalidTenant: "The tenant must be a valid address, different from the landlord and the arbiter.",
    InvalidAmount: "The amount is invalid (it must be above zero and not above the deposit).",
    InvalidTime: "The lease must end in the future, after its start (check your computer's clock).",
    InvalidWindow: "Each window must be between 1 minute and 90 days.",
    EmptyHash: "A file hash is required.",
    WrongDepositAmount: "The amount sent must equal the agreed deposit exactly.",
    ConditionReportMismatch: "The condition report does not match the one the landlord registered.",
    LeaseAlreadyEnded: "The lease has already ended, so the deposit can no longer be paid.",
    LeaseNotEnded: "The lease has not ended yet.",
    ProposalWindowClosed: "The window for proposing a deduction has closed.",
    ResponseWindowClosed: "The tenant's response window has closed; silence counts as agreement.",
    TimeoutNotReached: "The deadline has not passed yet.",
    AwardExceedsClaim: "The award cannot exceed what the landlord claimed.",
    NothingToWithdraw: "You have nothing to withdraw.",
    TransferFailed: "The transfer failed.",
  };

  // -------------------------------------------------------------------------
  // state
  // -------------------------------------------------------------------------
  const state = {
    config: null,
    provider: null,
    signer: null,
    contract: null,
    account: null, // lowercase address
    isArbiter: false,
    leases: [],
    selectedId: null,
    current: null, // lease read from the chain
    currentEvents: [],
    phase: null,
    token: null,
    tokenExpiresAt: 0,
    busy: false,
  };

  const $ = (selector) => document.querySelector(selector);

  // -------------------------------------------------------------------------
  // small helpers
  // -------------------------------------------------------------------------
  // Tiny DOM builder. Strings become text nodes, so nothing is ever parsed as HTML.
  function h(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === false || value == null) continue;
      if (key === "class") node.className = value;
      else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? "" : value);
    }
    for (const child of children.flat(Infinity)) {
      if (child == null || child === false) continue;
      node.append(child);
    }
    return node;
  }

  const short = (value) => (value ? `${value.slice(0, 6)}…${value.slice(-4)}` : "");
  const nowSec = () => Math.floor(Date.now() / 1000);
  const fmtDate = (ts) => new Date(ts * 1000).toLocaleString();

  function fmtEth(wei) {
    const text = ethers.formatEther(BigInt(wei));
    return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
  }

  function fmtDuration(seconds) {
    let s = Math.max(0, Math.floor(seconds));
    const d = Math.floor(s / 86400);
    const hh = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    s = s % 60;
    const parts = [];
    if (d) parts.push(`${d}d`);
    if (d || hh) parts.push(`${hh}h`);
    if (d || hh || m) parts.push(`${m}m`);
    parts.push(`${s}s`);
    return parts.join(" ");
  }

  // "0.01" -> 10000000000000000n; null when invalid (or zero, unless allowZero).
  function parseEthInput(text, allowZero = false) {
    const value = String(text).trim();
    if (!/^\d+(\.\d{1,18})?$/.test(value)) return null;
    const wei = ethers.parseEther(value);
    return wei > 0n || allowZero ? wei : null;
  }

  function checkFile(file) {
    if (!file) return "Choose a file.";
    if (file.size === 0) return "The file is empty.";
    if (file.size > state.config.maxFileBytes) {
      return `The file is too large (maximum ${state.config.maxFileBytes / 1024 / 1024} MB).`;
    }
    if (!state.config.allowedMimeTypes.includes(file.type)) {
      return "Only PNG, JPEG, PDF or plain-text files are allowed.";
    }
    return null;
  }

  function showProblems(list, problems) {
    list.replaceChildren(...problems.map((p) => h("li", {}, p)));
    list.classList.toggle("hidden", problems.length === 0);
    return problems.length > 0;
  }

  async function api(path, options = {}) {
    const init = { method: options.method || "GET", headers: {} };
    if (options.body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
    const response = await fetch(path, init);
    let data = null;
    try {
      data = await response.json();
    } catch {
      /* no body */
    }
    if (!response.ok) throw new Error((data && data.error) || `Request failed (${response.status})`);
    return data;
  }

  // -------------------------------------------------------------------------
  // errors and toasts
  // -------------------------------------------------------------------------
  function decodeRevert(error) {
    if (error && error.revert && error.revert.name) return error.revert.name;
    const candidates = [
      error && error.data,
      error && error.error && error.error.data,
      error && error.info && error.info.error && error.info.error.data,
      error && error.info && error.info.error && error.info.error.data && error.info.error.data.data,
      error && error.error && error.error.data && error.error.data.data,
    ];
    for (const c of candidates) {
      if (typeof c === "string" && c.startsWith("0x") && c.length >= 10 && state.contract) {
        try {
          const parsed = state.contract.interface.parseError(c);
          if (parsed) return parsed.name;
        } catch {
          /* not one of our errors */
        }
      }
    }
    return null;
  }

  function errorMessage(error) {
    if (!error) return "Unknown error.";
    if (error.code === "ACTION_REJECTED" || (error.info && error.info.error && error.info.error.code === 4001)) {
      return "You rejected the request in MetaMask.";
    }
    const name = decodeRevert(error);
    if (name) return ERROR_MESSAGES[name] || name;
    return error.shortMessage || error.reason || error.message || String(error);
  }

  function txLink(hash) {
    if (state.config && state.config.explorer) {
      return h("a", { href: `${state.config.explorer}/tx/${hash}`, target: "_blank", rel: "noopener noreferrer" }, "view on Etherscan");
    }
    return h("span", { class: "mono" }, short(hash));
  }

  function toast(text, kind = "info") {
    const message = h("span", {}, text);
    const node = h(
      "div",
      { class: `toast ${kind}` },
      message,
      h("button", { class: "toast-close", type: "button", "aria-label": "Dismiss", onclick: () => node.remove() }, "×")
    );
    $("#toasts").append(node);

    const autoClose = () => setTimeout(() => node.remove(), 12000);
    if (kind === "success") autoClose();

    return {
      update(newText, newKind, txHash) {
        node.className = `toast ${newKind || kind}`;
        message.replaceChildren(newText);
        if (txHash) message.append(" ", txLink(txHash));
        if (newKind === "success") autoClose();
      },
    };
  }

  function showBanner(text, buttonLabel, onClick) {
    const banner = $("#banner");
    banner.replaceChildren(h("span", {}, text));
    if (buttonLabel) banner.append(h("button", { class: "btn small", type: "button", onclick: onClick }, buttonLabel));
    banner.classList.remove("hidden");
  }

  const hideBanner = () => $("#banner").classList.add("hidden");

  // -------------------------------------------------------------------------
  // authentication (sign a free message with MetaMask)
  // -------------------------------------------------------------------------
  const sessionKey = () => `session:${state.account}`;

  function clearSession() {
    state.token = null;
    state.tokenExpiresAt = 0;
    try {
      sessionStorage.removeItem(sessionKey());
    } catch {
      /* storage unavailable */
    }
  }

  async function ensureLogin() {
    const valid = () => state.token && state.tokenExpiresAt - 30000 > Date.now();
    if (valid()) return state.token;

    try {
      const saved = JSON.parse(sessionStorage.getItem(sessionKey()) || "null");
      if (saved) {
        state.token = saved.token;
        state.tokenExpiresAt = saved.expiresAt;
      }
    } catch {
      /* ignore */
    }
    if (valid()) return state.token;

    const { message } = await api(`/api/auth/nonce?address=${state.account}`);
    const signature = await state.signer.signMessage(message);
    const { token, expiresAt } = await api("/api/auth/login", {
      method: "POST",
      body: { address: state.account, signature },
    });
    state.token = token;
    state.tokenExpiresAt = expiresAt;
    try {
      sessionStorage.setItem(sessionKey(), JSON.stringify({ token, expiresAt }));
    } catch {
      /* ignore */
    }
    return token;
  }

  // fetch() with the bearer token; signs in again once if the server no longer knows the token.
  async function authedFetch(path, init = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await ensureLogin();
      const response = await fetch(path, {
        ...init,
        headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
      });
      if (response.status !== 401) return response;
      clearSession();
    }
    throw new Error("Could not sign in. Please try again.");
  }

  async function uploadFile(file) {
    const url = `/api/files?filename=${encodeURIComponent(file.name)}&type=${encodeURIComponent(file.type)}`;
    const response = await authedFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: file,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Upload failed (${response.status})`);
    return data; // { hash, size, filename }
  }

  async function downloadFile(hash, fallbackName) {
    const response = await authedFetch(`/api/files/${hash}`);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `Download failed (${response.status})`);
    }
    const disposition = response.headers.get("Content-Disposition") || "";
    const match = /filename\*=UTF-8''([^;]+)/.exec(disposition);
    const name = match ? decodeURIComponent(match[1]) : fallbackName || "file";

    const url = URL.createObjectURL(await response.blob());
    const link = h("a", { href: url, download: name });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // -------------------------------------------------------------------------
  // wallet connection
  // -------------------------------------------------------------------------
  async function connect() {
    try {
      await window.ethereum.request({ method: "eth_requestAccounts" });
      await onConnected();
    } catch (error) {
      toast(errorMessage(error), "error");
    }
  }

  async function switchNetwork() {
    const chainIdHex = "0x" + state.config.chainId.toString(16);
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainIdHex }] });
    } catch (error) {
      toast(`Please switch MetaMask to ${state.config.network} (chain id ${state.config.chainId}) manually.`, "error");
    }
  }

  async function onConnected() {
    state.provider = new ethers.BrowserProvider(window.ethereum);
    const network = await state.provider.getNetwork();
    if (Number(network.chainId) !== state.config.chainId) {
      showBanner(
        `MetaMask is on the wrong network. This app uses ${state.config.network} (chain id ${state.config.chainId}).`,
        "Switch network",
        switchNetwork
      );
      return;
    }
    hideBanner();

    state.signer = await state.provider.getSigner();
    state.account = (await state.signer.getAddress()).toLowerCase();
    state.contract = new ethers.Contract(state.config.contractAddress, state.config.abi, state.signer);
    state.isArbiter = state.account === state.config.arbiter.toLowerCase();

    renderAccount();
    $("#new-lease-btn").classList.toggle("hidden", state.isArbiter);

    await refreshAll();

    const wanted = Number((/lease=(\d+)/.exec(location.hash) || [])[1]);
    if (wanted) await showLease(wanted);
    else renderWelcome();

    if (!state.timersStarted) {
      state.timersStarted = true;
      setInterval(() => {
        if (!state.busy) refreshAll().catch(() => {});
      }, 20000);
      setInterval(tick, 1000);
    }
  }

  function roleOf(lease) {
    if (lease.landlord === state.account) return "landlord";
    if (lease.tenant === state.account) return "tenant";
    if (state.isArbiter) return "arbiter";
    return "observer";
  }

  function renderAccount() {
    const roleText = state.isArbiter ? "Platform arbiter" : "Account";
    $("#account-box").replaceChildren(
      h(
        "div",
        { class: "account" },
        h("span", { class: "chip role" }, roleText),
        h("span", { class: "mono", title: state.account }, short(state.account))
      )
    );
    const badge = $("#network-badge");
    badge.textContent = `${state.config.network} · chain ${state.config.chainId}`;
    badge.classList.remove("hidden");
  }

  // -------------------------------------------------------------------------
  // data loading
  // -------------------------------------------------------------------------
  async function readLeaseFromChain(id) {
    const l = await state.contract.getLease(id);
    return {
      id,
      landlord: l.landlord.toLowerCase(),
      tenant: l.tenant.toLowerCase(),
      depositAmount: l.depositAmount,
      deductionAmount: l.deductionAmount,
      startTime: Number(l.startTime),
      endTime: Number(l.endTime),
      proposalWindow: Number(l.proposalWindow),
      responseWindow: Number(l.responseWindow),
      proposedAt: Number(l.proposedAt),
      status: Number(l.status),
      conditionReportHash: l.conditionReportHash,
      evidenceHash: l.evidenceHash,
    };
  }

  async function loadLeaseData(id) {
    const lease = await readLeaseFromChain(id);
    let events = [];
    try {
      events = (await api(`/api/leases/${id}`)).events;
    } catch {
      /* not indexed yet; the history fills in a few seconds later */
    }
    return [lease, events];
  }

  async function loadLeaseList() {
    const data = await api(`/api/leases?address=${state.account}`);
    state.leases = data.leases;
    renderLeaseList();
  }

  async function loadBalance() {
    const pending = await state.contract.pendingWithdrawals(state.account);
    const box = $("#balance-box");
    if (pending === 0n) {
      box.classList.add("hidden");
      return;
    }
    box.replaceChildren(
      h("span", {}, `Withdrawable: ${fmtEth(pending)} ETH`),
      h(
        "button",
        { class: "btn small primary", type: "button", onclick: () => runFlow(withdraw) },
        "Withdraw"
      )
    );
    box.classList.remove("hidden");
  }

  async function refreshCurrent() {
    if (!state.selectedId) return;
    const [lease, events] = await loadLeaseData(state.selectedId);
    const signature = (l) => `${l.status}:${l.deductionAmount}:${l.proposedAt}`;
    const changed =
      !state.current || signature(lease) !== signature(state.current) || events.length !== state.currentEvents.length;
    state.current = lease;
    state.currentEvents = events;
    if (changed) renderLease();
  }

  async function refreshAll() {
    await Promise.all([loadLeaseList(), loadBalance()]);
    await refreshCurrent();
  }

  async function afterTx() {
    try {
      await api("/api/sync", { method: "POST" });
    } catch {
      /* the backend may be catching up; the periodic refresh will pick it up */
    }
    await refreshAll();
    setTimeout(() => refreshAll().catch(() => {}), 4000); // RPC nodes can lag a moment behind
  }

  // -------------------------------------------------------------------------
  // transactions
  // -------------------------------------------------------------------------
  async function runFlow(fn) {
    if (state.busy) return;
    state.busy = true;
    document.body.classList.add("busy");
    try {
      await fn();
    } catch (error) {
      toast(errorMessage(error), "error");
    } finally {
      state.busy = false;
      document.body.classList.remove("busy");
    }
  }

  // Simulates the call first (so a revert shows a readable message and costs no gas), then sends it
  // through MetaMask and waits for the receipt. Returns the receipt, or null if it failed.
  async function sendTx(label, method, args = [], overrides = {}) {
    const t = toast(`${label}: checking…`);
    try {
      await state.contract[method].staticCall(...args, overrides);
      t.update(`${label}: confirm the transaction in MetaMask…`);
      const tx = await state.contract[method](...args, overrides);
      t.update(`${label}: sent, waiting for confirmation…`, "info", tx.hash);
      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) throw new Error("The transaction was reverted.");
      t.update(`${label}: confirmed in block ${receipt.blockNumber}.`, "success", tx.hash);
      return receipt;
    } catch (error) {
      t.update(`${label} failed: ${errorMessage(error)}`, "error");
      return null;
    }
  }

  async function doAction(label, method, args = [], overrides = {}) {
    await runFlow(async () => {
      const receipt = await sendTx(label, method, args, overrides);
      if (receipt) await afterTx();
    });
  }

  async function withdraw() {
    const receipt = await sendTx("Withdraw", "withdraw");
    if (receipt) await afterTx();
  }

  // -------------------------------------------------------------------------
  // navigation
  // -------------------------------------------------------------------------
  async function selectLease(id) {
    await showLease(id);
  }

  async function showLease(id) {
    state.selectedId = id;
    history.replaceState(null, "", `#lease=${id}`);
    renderLeaseList();
    try {
      const [lease, events] = await loadLeaseData(id);
      state.current = lease;
      state.currentEvents = events;
      renderLease();
    } catch (error) {
      state.current = null;
      renderMessage(`Lease #${id} could not be loaded: ${errorMessage(error)}`);
    }
  }

  function clearSelection() {
    state.selectedId = null;
    state.current = null;
    state.phase = null;
    history.replaceState(null, "", location.pathname);
    renderLeaseList();
  }

  function setContent(...nodes) {
    $("#content").replaceChildren(...nodes);
  }

  // -------------------------------------------------------------------------
  // views
  // -------------------------------------------------------------------------
  function renderMessage(text) {
    setContent(h("div", { class: "card" }, h("p", {}, text)));
  }

  function renderWelcome() {
    clearSelection();
    setContent(
      h(
        "div",
        { class: "card" },
        h("h3", {}, "How it works"),
        h(
          "ol",
          {},
          h("li", {}, "The landlord creates a lease and registers the move-in condition report."),
          h("li", {}, "The tenant reviews the report and pays the deposit into the smart contract."),
          h("li", {}, "After the lease ends, the landlord returns the deposit or proposes a deduction with evidence."),
          h("li", {}, "The tenant accepts or rejects. Silence has a defined outcome, and the platform arbiter rules on disputes.")
        ),
        h(
          "p",
          { class: "muted" },
          "Switch accounts in MetaMask to act as a different role; the page reloads and shows the actions that account can take."
        )
      )
    );
  }

  function renderLeaseList() {
    const list = $("#lease-list");
    if (!state.account) return;
    if (state.leases.length === 0) {
      list.replaceChildren(h("li", { class: "empty" }, state.isArbiter ? "No leases on the platform yet." : "No leases yet. Create one, or ask your landlord to."));
      return;
    }
    list.replaceChildren(
      ...state.leases.map((lease) =>
        h(
          "li",
          { class: "lease-item" + (lease.id === state.selectedId ? " active" : ""), onclick: () => selectLease(lease.id) },
          h("div", { class: "lease-title" }, `Lease #${lease.id}`, h("span", { class: `chip s${lease.status}` }, STATUS_NAMES[lease.status])),
          h("div", { class: "lease-sub" }, `${fmtEth(lease.depositWei)} ETH · ${roleOf(lease)}`)
        )
      )
    );
  }

  // ---- new lease form -------------------------------------------------------
  function unitSelect(name, selected) {
    return h(
      "select",
      { name },
      Object.keys(UNITS).map((unit) => h("option", { value: unit, selected: unit === selected }, unit))
    );
  }

  function field(label, input, hint) {
    return h("div", { class: "field" }, h("label", {}, label), input, hint ? h("span", { class: "hint" }, hint) : null);
  }

  // The browser draws the text of a native file input in the browser's own language ("选择文件" on a
  // Chinese browser). To keep the page in English, hide the native input and show our own button and
  // file name. The real input stays in the DOM, so form.elements and .files keep working.
  const FILE_ACCEPT = ".png,.jpg,.jpeg,.pdf,.txt";

  function fileField(name) {
    const attrs = { type: "file", class: "file-native", accept: FILE_ACCEPT, tabindex: "-1" };
    if (name) attrs.name = name;
    const input = h("input", attrs);
    const label = h("span", { class: "muted file-name" }, "No file chosen");
    const choose = h("button", { class: "btn", type: "button", onclick: () => input.click() }, "Choose file");
    input.addEventListener("change", () => {
      label.textContent = input.files[0] ? input.files[0].name : "No file chosen";
    });
    return { input, wrap: h("div", { class: "file-picker" }, input, choose, label) };
  }

  function renderNewLease() {
    clearSelection();
    const errors = h("ul", { class: "errors hidden" });

    const form = h(
      "form",
      { class: "form", novalidate: true },
      field("Tenant address", h("input", { type: "text", name: "tenant", placeholder: "0x…", autocomplete: "off", spellcheck: "false" }), "The tenant's MetaMask address (a different account from yours)."),
      field("Deposit (ETH)", h("input", { type: "text", name: "deposit", value: "0.01", inputmode: "decimal" }), "Use a small amount on the test network."),
      field(
        "Lease length",
        h("div", { class: "inline" }, h("input", { type: "number", name: "duration", value: "10", min: "1" }), unitSelect("durationUnit", "minutes")),
        "Demo tip: use minutes. A real lease would use months."
      ),
      field(
        "Landlord proposal window",
        h("div", { class: "inline" }, h("input", { type: "number", name: "proposalWindow", value: "3", min: "1" }), unitSelect("proposalUnit", "minutes")),
        "Time after the lease ends in which the landlord may propose a deduction. If it passes, the tenant gets the full deposit."
      ),
      field(
        "Tenant response window",
        h("div", { class: "inline" }, h("input", { type: "number", name: "responseWindow", value: "3", min: "1" }), unitSelect("responseUnit", "minutes")),
        "Time the tenant has to answer a proposal. If it passes, the proposed deduction applies."
      ),
      field(
        "Move-in condition report",
        fileField("report").wrap,
        "PNG, JPEG, PDF or text, up to 10 MB. Only its SHA-256 hash goes on-chain; the file stays private."
      ),
      errors,
      h("div", { class: "actions-row" }, h("button", { class: "btn primary", type: "submit" }, "Create lease"))
    );

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      runFlow(() => submitNewLease(form, errors));
    });

    setContent(h("div", { class: "card" }, h("h3", {}, "New lease"), form));
  }

  async function submitNewLease(form, errorList) {
    const el = form.elements;
    const problems = [];

    const tenant = el.tenant.value.trim();
    if (!ethers.isAddress(tenant)) problems.push("The tenant must be a valid Ethereum address.");
    else if (tenant.toLowerCase() === state.account) problems.push("You cannot be your own tenant.");
    else if (tenant.toLowerCase() === state.config.arbiter.toLowerCase()) problems.push("The platform arbiter account cannot be the tenant.");

    const depositAmount = parseEthInput(el.deposit.value);
    if (depositAmount === null) problems.push("The deposit must be a positive amount in ETH (up to 18 decimals).");

    const seconds = (valueInput, unitSelectEl) => Number(valueInput.value) * UNITS[unitSelectEl.value];
    const duration = seconds(el.duration, el.durationUnit);
    const proposalWindow = seconds(el.proposalWindow, el.proposalUnit);
    const responseWindow = seconds(el.responseWindow, el.responseUnit);

    if (!Number.isInteger(duration) || duration < MIN_WINDOW) problems.push("The lease must be at least 1 minute long.");
    for (const [name, value] of [["proposal window", proposalWindow], ["response window", responseWindow]]) {
      if (!Number.isInteger(value) || value < MIN_WINDOW || value > MAX_WINDOW) {
        problems.push(`The ${name} must be between 1 minute and 90 days.`);
      }
    }

    const file = el.report.files[0];
    const fileProblem = checkFile(file);
    if (fileProblem) problems.push(`Condition report: ${fileProblem}`);

    if (showProblems(errorList, problems)) return;

    const upload = await uploadFile(file);
    const start = nowSec();
    const terms = {
      tenant: ethers.getAddress(tenant),
      depositAmount,
      startTime: start,
      endTime: start + duration,
      proposalWindow,
      responseWindow,
      conditionReportHash: upload.hash,
    };

    const receipt = await sendTx("Create lease", "createLease", [terms]);
    if (!receipt) return;

    let newId = null;
    for (const log of receipt.logs) {
      try {
        const parsed = state.contract.interface.parseLog(log);
        if (parsed && parsed.name === "LeaseCreated") newId = Number(parsed.args.leaseId);
      } catch {
        /* log from another contract */
      }
    }
    await afterTx();
    if (newId) await showLease(newId);
  }

  // ---- lease detail ---------------------------------------------------------
  function phaseKey(lease) {
    const now = nowSec();
    const end = lease.endTime;
    return [
      lease.status,
      now >= end,
      now > end + lease.proposalWindow,
      now > lease.proposedAt + lease.responseWindow,
    ].join(":");
  }

  function deadlineInfo(lease) {
    const now = nowSec();
    const end = lease.endTime;
    const proposalDeadline = end + lease.proposalWindow;
    const responseDeadline = lease.proposedAt + lease.responseWindow;

    switch (lease.status) {
      case S.Created:
        return now < end
          ? { label: "The deposit must be paid before the lease ends, in", at: end }
          : { label: "The lease period passed without a deposit. It can only be cancelled.", at: null };
      case S.Funded:
        if (now < end) return { label: "Lease ends in", at: end };
        if (now <= proposalDeadline) return { label: "Landlord can propose a deduction for another", at: proposalDeadline };
        return { label: "The proposal window has closed.", at: null };
      case S.DeductionProposed:
        return now <= responseDeadline
          ? { label: "The tenant must respond within", at: responseDeadline }
          : { label: "The tenant's response window has closed.", at: null };
      case S.Disputed:
        return { label: "Waiting for the arbiter's ruling.", at: null };
      default:
        return null;
    }
  }

  function describeEvent(event) {
    const a = event.args;
    switch (event.name) {
      case "LeaseCreated":
        return `Lease created: deposit ${fmtEth(a.depositAmount)} ETH, landlord ${short(a.landlord)}, tenant ${short(a.tenant)}.`;
      case "DepositPaid":
        return `Tenant paid the deposit (${fmtEth(a.amount)} ETH) and acknowledged the move-in report.`;
      case "LeaseCancelled":
        return `Lease cancelled by ${short(a.by)}.`;
      case "DeductionProposed":
        return `Landlord proposed a deduction of ${fmtEth(a.amount)} ETH.`;
      case "DeductionRejected":
        return "Tenant rejected the deduction; the case went to the arbiter.";
      case "LeaseSettled":
        return `Settled (${SETTLEMENT_NAMES[Number(a.settlementType)]}): landlord ${fmtEth(a.landlordAmount)} ETH, tenant ${fmtEth(a.tenantAmount)} ETH.`;
      default:
        return event.name;
    }
  }

  function renderLease() {
    const lease = state.current;
    if (!lease) return;
    state.phase = phaseKey(lease);
    const role = roleOf(lease);

    const nodes = [buildHeader(lease, role), buildTerms(lease), buildActions(lease, role)];
    if (role !== "observer") nodes.push(buildFilesCard(lease));
    nodes.push(buildHistory());
    setContent(...nodes);
  }

  function buildHeader(lease, role) {
    const visited = new Set([lease.status]);
    for (const event of state.currentEvents) {
      if (event.name === "LeaseCreated") visited.add(S.Created);
      if (event.name === "DepositPaid") visited.add(S.Funded);
      if (event.name === "DeductionProposed") visited.add(S.DeductionProposed);
      if (event.name === "DeductionRejected") visited.add(S.Disputed);
      if (event.name === "LeaseSettled") visited.add(S.Settled);
    }

    const stepper =
      lease.status === S.Cancelled
        ? h("div", { class: "stepper" }, h("span", { class: "step current" }, "Cancelled"))
        : h(
            "div",
            { class: "stepper" },
            STEPS.map(([name, value]) =>
              h("span", { class: "step" + (value === lease.status ? " current" : visited.has(value) ? " done" : "") }, name)
            )
          );

    const info = deadlineInfo(lease);
    const deadline = info
      ? h(
          "div",
          { class: "deadline" },
          h("span", {}, info.label),
          info.at ? h("strong", { "data-countdown": info.at }, fmtDuration(info.at - nowSec())) : null
        )
      : null;

    return h(
      "div",
      { class: "card" },
      h(
        "div",
        { class: "lease-head" },
        h("h2", {}, `Lease #${lease.id}`),
        h("span", { class: `chip s${lease.status}` }, STATUS_NAMES[lease.status]),
        h("span", { class: "chip role" }, role === "observer" ? "not a party" : `you: ${role}`),
        h("button", { class: "btn small", type: "button", onclick: () => runFlow(refreshAll) }, "Refresh")
      ),
      stepper,
      deadline ? h("div", { style: "margin-top:12px" }, deadline) : null
    );
  }

  function buildTerms(lease) {
    const who = (address) => (address === state.account ? `${address} (you)` : address);
    const item = (label, value, mono) => [h("dt", {}, label), h("dd", { class: mono ? "mono" : null }, value)];

    const rows = [
      item("Landlord", who(lease.landlord), true),
      item("Tenant", who(lease.tenant), true),
      item("Deposit", `${fmtEth(lease.depositAmount)} ETH`),
      item("Lease period", `${fmtDate(lease.startTime)} → ${fmtDate(lease.endTime)}`),
      item("Landlord proposal window", `${fmtDuration(lease.proposalWindow)} after the lease ends`),
      item("Tenant response window", `${fmtDuration(lease.responseWindow)} after a proposal`),
      item("Move-in report hash", lease.conditionReportHash, true),
    ];
    if (lease.deductionAmount > 0n) {
      rows.push(item("Claimed deduction", `${fmtEth(lease.deductionAmount)} ETH`));
      rows.push(item("Evidence hash", lease.evidenceHash, true));
    }

    const contractRow = state.config.explorer
      ? h("a", { href: `${state.config.explorer}/address/${state.config.contractAddress}`, target: "_blank", rel: "noopener noreferrer" }, short(state.config.contractAddress))
      : h("span", { class: "mono" }, state.config.contractAddress);

    return h(
      "div",
      { class: "card" },
      h("h3", {}, "Terms"),
      h("dl", { class: "terms" }, rows),
      h("p", { class: "muted" }, "Contract: ", contractRow)
    );
  }

  // ---- actions --------------------------------------------------------------
  function buildActions(lease, role) {
    const now = nowSec();
    const end = lease.endTime;
    const proposalDeadline = end + lease.proposalWindow;
    const responseDeadline = lease.proposedAt + lease.responseWindow;
    const isParty = role === "landlord" || role === "tenant";

    const card = h("div", { class: "card" }, h("h3", {}, "Actions"));
    const note = (text) => card.append(h("p", { class: "muted" }, text));
    const button = (label, className, onclick) => h("button", { class: `btn ${className}`.trim(), type: "button", onclick }, label);
    const row = (...buttons) => card.append(h("div", { class: "actions-row" }, ...buttons));
    // Anyone may press this once a deadline has passed. It does not decide anything: the outcome was already
    // fixed by the deadline. A contract cannot run by itself, so someone has to submit the transaction.
    const timeoutButton = (label) => {
      note("Anyone can press this button, not only the party who stayed silent. It does not change the outcome; it only records the result the deadline already decided, because a smart contract cannot run by itself and needs someone to send this transaction.");
      return button(label, "primary", () => doAction("Finalize lease", "claimByTimeout", [lease.id]));
    };

    switch (lease.status) {
      case S.Created:
        if (role === "tenant") card.append(buildPayForm(lease));
        else if (role === "landlord") note("Waiting for the tenant to review the move-in report and pay the deposit.");
        else note("Waiting for the tenant's deposit.");
        if (isParty) row(button("Cancel lease", "danger", () => doAction("Cancel lease", "cancelLease", [lease.id])));
        break;

      case S.Funded:
        if (now < end) {
          note(`The deposit is locked in the contract until the lease ends (${fmtDate(end)}).`);
        } else if (now <= proposalDeadline) {
          if (role === "landlord") {
            note("The lease has ended. Return the full deposit, or propose a deduction with evidence.");
            row(button("Return full deposit", "primary", () => doAction("Return deposit", "releaseDeposit", [lease.id])));
            card.append(buildProposeForm(lease));
          } else {
            note("Waiting for the landlord to return the deposit or propose a deduction. If the landlord stays silent until the proposal window closes, the tenant receives the full deposit.");
          }
        } else {
          note("The landlord did not propose a deduction before the proposal window closed. By the default rule the tenant receives the full deposit.");
          row(timeoutButton("Finalize: full refund to tenant"));
        }
        break;

      case S.DeductionProposed: {
        const tenantShare = lease.depositAmount - lease.deductionAmount;
        note(`The landlord claims ${fmtEth(lease.deductionAmount)} ETH of the ${fmtEth(lease.depositAmount)} ETH deposit. The tenant would receive ${fmtEth(tenantShare)} ETH.`);
        if (now <= responseDeadline) {
          if (role === "tenant") {
            note("Accepting settles immediately. Rejecting sends the case to the platform arbiter. Staying silent counts as agreement.");
            row(
              button("Accept deduction", "primary", () => doAction("Accept deduction", "acceptDeduction", [lease.id])),
              button("Reject deduction", "danger", () => doAction("Reject deduction", "rejectDeduction", [lease.id]))
            );
          } else {
            note("Waiting for the tenant to accept or reject. If the tenant stays silent, the proposed deduction applies.");
          }
        } else {
          note("The tenant did not accept or reject before the response window closed. By the default rule the proposed deduction applies.");
          row(timeoutButton("Finalize: apply the proposed deduction"));
        }
        break;
      }

      case S.Disputed:
        if (role === "arbiter") card.append(buildResolveForm(lease));
        else note("The tenant rejected the deduction. The deposit stays locked until the platform arbiter rules.");
        break;

      case S.Settled: {
        const settled = state.currentEvents.find((e) => e.name === "LeaseSettled");
        note(settled ? describeEvent(settled) : "This lease is settled.");
        note("Each party collects their share with the Withdraw button at the top of the page.");
        break;
      }

      default:
        note("This lease was cancelled before the deposit was paid.");
    }
    return card;
  }

  function buildPayForm(lease) {
    const ack = h("input", { type: "checkbox" });
    const pay = h(
      "button",
      {
        class: "btn primary",
        type: "button",
        disabled: true,
        onclick: () =>
          doAction("Pay deposit", "payDeposit", [lease.id, lease.conditionReportHash], { value: lease.depositAmount }),
      },
      `Pay ${fmtEth(lease.depositAmount)} ETH deposit`
    );
    ack.addEventListener("change", () => {
      pay.disabled = !ack.checked;
    });

    return h(
      "div",
      {},
      h("p", {}, `Deposit: ${fmtEth(lease.depositAmount)} ETH. Paying also records that you accept the landlord's move-in condition report (hash ${short(lease.conditionReportHash)}) as the baseline condition of the property.`),
      h("div", { class: "actions-row" }, h("button", { class: "btn", type: "button", onclick: () => runFlow(() => downloadFile(lease.conditionReportHash, "move-in-report")) }, "Download the move-in report")),
      h("label", { class: "checkbox", style: "margin-top:12px" }, ack, h("span", {}, "I have reviewed the move-in condition report.")),
      h("div", { class: "actions-row" }, pay)
    );
  }

  function buildProposeForm(lease) {
    const amount = h("input", { type: "text", inputmode: "decimal", placeholder: "e.g. 0.002" });
    const picker = fileField();
    const file = picker.input;
    const errors = h("ul", { class: "errors hidden" });

    const submit = () =>
      runFlow(async () => {
        const problems = [];
        const wei = parseEthInput(amount.value);
        if (wei === null) problems.push("Enter a positive amount in ETH (up to 18 decimals).");
        else if (wei > lease.depositAmount) problems.push(`The deduction cannot exceed the deposit (${fmtEth(lease.depositAmount)} ETH).`);
        const fileProblem = checkFile(file.files[0]);
        if (fileProblem) problems.push(`Evidence: ${fileProblem}`);
        if (showProblems(errors, problems)) return;

        const upload = await uploadFile(file.files[0]);
        const receipt = await sendTx("Propose deduction", "proposeDeduction", [lease.id, wei, upload.hash]);
        if (receipt) await afterTx();
      });

    return h(
      "div",
      { class: "subform" },
      h("h4", {}, "Propose a deduction"),
      h("div", { class: "form" }, field("Amount to keep (ETH)", amount, `At most ${fmtEth(lease.depositAmount)} ETH.`), field("Evidence (photos, invoice…)", picker.wrap, "Only the file's hash goes on-chain."), errors, h("div", { class: "actions-row" }, h("button", { class: "btn primary", type: "button", onclick: submit }, "Propose deduction")))
    );
  }

  function buildResolveForm(lease) {
    const claimed = lease.deductionAmount;
    const amount = h("input", { type: "text", inputmode: "decimal", value: fmtEth(claimed) });
    const preview = h("span", { class: "hint" });
    const errors = h("ul", { class: "errors hidden" });

    const update = () => {
      const wei = parseEthInput(amount.value, true);
      preview.textContent =
        wei !== null && wei <= claimed
          ? `The tenant receives ${fmtEth(lease.depositAmount - wei)} ETH.`
          : "";
    };
    amount.addEventListener("input", update);
    update();

    const submit = () =>
      runFlow(async () => {
        const wei = parseEthInput(amount.value, true);
        const problems = [];
        if (wei === null) problems.push("Enter an amount in ETH (0 is allowed).");
        else if (wei > claimed) problems.push(`The award cannot exceed the claim (${fmtEth(claimed)} ETH).`);
        if (showProblems(errors, problems)) return;
        const receipt = await sendTx("Resolve dispute", "resolveDispute", [lease.id, wei]);
        if (receipt) await afterTx();
      });

    return h(
      "div",
      {},
      h("p", {}, `The landlord claims ${fmtEth(claimed)} ETH of the ${fmtEth(lease.depositAmount)} ETH deposit. Review the evidence below, then decide how much the landlord receives. The tenant receives the rest.`),
      h("div", { class: "form" }, field("Amount awarded to the landlord (ETH)", amount, null), preview, errors),
      h(
        "div",
        { class: "actions-row" },
        h("button", { class: "btn", type: "button", onclick: () => { amount.value = "0"; update(); } }, "Award nothing"),
        h("button", { class: "btn", type: "button", onclick: () => { amount.value = fmtEth(claimed); update(); } }, "Award the full claim"),
        h("button", { class: "btn primary", type: "button", onclick: submit }, "Submit ruling")
      )
    );
  }

  // ---- files ----------------------------------------------------------------
  function buildFilesCard(lease) {
    const body = h("div", {}, h("p", { class: "muted" }, "Files are private to the parties and the arbiter. Showing them asks you to sign a free message that proves you control this address."));

    const load = () =>
      runFlow(async () => {
        const response = await authedFetch(`/api/leases/${lease.id}/files`);
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
        renderFiles(body, data.files);
      });

    return h("div", { class: "card" }, h("h3", {}, "Files"), body, h("div", { class: "actions-row" }, h("button", { class: "btn", type: "button", onclick: load }, "Show files")));
  }

  function renderFiles(container, files) {
    const kindLabel = { conditionReport: "Move-in report", evidence: "Deduction evidence" };
    if (files.length === 0) {
      container.replaceChildren(h("p", { class: "muted" }, "No files registered for this lease."));
      return;
    }
    container.replaceChildren(
      ...files.map((file) => {
        let integrity = h("span", { class: "muted" }, "not stored on this server");
        if (file.available) {
          integrity = file.intact
            ? h("span", { class: "ok" }, "✓ matches the on-chain hash")
            : h("span", { class: "bad" }, "✗ does NOT match the on-chain hash");
        }
        return h(
          "div",
          { class: "file-row" },
          h("div", {}, h("strong", {}, kindLabel[file.kind] || file.kind), h("div", { class: "muted" }, file.filename ? `${file.filename} · ${file.size} bytes · ` : "", h("span", { class: "mono" }, short(file.hash))), integrity),
          file.available ? h("button", { class: "btn small", type: "button", onclick: () => runFlow(() => downloadFile(file.hash, file.filename)) }, "Download") : null
        );
      })
    );
  }

  // ---- history --------------------------------------------------------------
  function buildHistory() {
    const card = h("div", { class: "card" }, h("h3", {}, "History"));
    if (state.currentEvents.length === 0) {
      card.append(h("p", { class: "muted" }, "No events indexed yet. If you just sent a transaction, this fills in within a few seconds."));
      return card;
    }
    const rows = state.currentEvents.map((event) =>
      h("tr", {}, h("td", {}, fmtDate(event.blockTime)), h("td", {}, describeEvent(event)), h("td", {}, txLink(event.txHash)))
    );
    card.append(
      h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Time"), h("th", {}, "Event"), h("th", {}, "Transaction"))), h("tbody", {}, rows)))
    );
    return card;
  }

  // -------------------------------------------------------------------------
  // timers
  // -------------------------------------------------------------------------
  function tick() {
    document.querySelectorAll("[data-countdown]").forEach((node) => {
      node.textContent = fmtDuration(Number(node.dataset.countdown) - nowSec());
    });
    // A deadline passed, so different actions are available: redraw.
    if (state.current && state.phase && !state.busy && phaseKey(state.current) !== state.phase) renderLease();
  }

  // -------------------------------------------------------------------------
  // start
  // -------------------------------------------------------------------------
  async function init() {
    try {
      state.config = await api("/api/config");
    } catch (error) {
      showBanner(`Could not load the app configuration: ${error.message}`);
      return;
    }

    $("#connect-btn").addEventListener("click", connect);
    $("#new-lease-btn").addEventListener("click", renderNewLease);
    renderWelcome();

    if (!window.ethereum) {
      showBanner("MetaMask was not detected. Install the MetaMask browser extension to use this app.");
      $("#connect-btn").disabled = true;
      return;
    }

    // Switching account or network is handled by reloading, which keeps the state simple and correct.
    window.ethereum.on("accountsChanged", () => location.reload());
    window.ethereum.on("chainChanged", () => location.reload());

    try {
      const accounts = await window.ethereum.request({ method: "eth_accounts" });
      if (accounts.length > 0) await onConnected();
    } catch (error) {
      toast(errorMessage(error), "error");
    }
  }

  init();
})();
