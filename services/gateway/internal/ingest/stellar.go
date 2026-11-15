// SPDX-License-Identifier: Apache-2.0

package ingest

// Stellar event schema v1 (`scf-stellar-events/1`, wire-formats §a.3.1, C-136, C-137): the closed vocabulary, the
// mapping of legacy ADR-0029 wallet events (schema version 0) to v1, the gateway-enforced field placement, the
// counted-only rule and the property rows of the counter record (§d.3 `props`). Every value is a closed enum: no
// address, hash, amount, XDR, memo, signature, passphrase or free text can be expressed.

// v1 closed lists (§a.3 `$defs/stellar`).
var (
	stellarNames = set("wallet_modal_opened", "wallet_modal_closed", "wallet_selected", "wallet_connect",
		"wallet_disconnect", "sign_requested", "sign_approved", "sign_rejected", "tx_submitted",
		"smart_wallet_created", "passkey_used",
		// tracker 1.2.0: connect failures and the WalletConnect funnel
		"wallet_connect_failed", "walletconnect_session", "walletconnect_request")
	stellarWallets = set("freighter", "albedo", "xbull", "lobstr", "hana", "hot", "rabet", "walletconnect", "ledger",
		"trezor", "fordefi", "klever", "onekey", "bitget", "cactuslink", "dcent", "scopuly", "metamask", "ghostsig",
		"passkey", "privy", "injected_other", "unknown")
	stellarNetworks    = set("mainnet", "testnet", "futurenet", "local", "unknown")
	stellarConnect     = set("new", "restored")
	stellarErrClasses  = set("user_rejected", "invalid_request", "external_service", "internal", "timeout", "unsupported", "unknown")
	stellarResults     = set("success", "failed", "pending", "try_again_later", "error")
	stellarPasskeyOps  = set("register", "authenticate", "sign")
	stellarFailReasons = set("user_rejected", "wallet_not_installed", "wallet_locked", "network_mismatch", "timeout", "error_other")
	stellarContexts    = set("none", "varial_inapp", "dcent_inapp", "scopuly_inapp", "other_inapp", "unknown")
	stellarWCStates    = set("proposed", "approved", "rejected")
	stellarWCMethods   = set("sign_xdr", "sign_submit_xdr", "sign_message", "sign_auth_entry")
)

// countedOnly are the v1 events that can coincide with a public ledger transaction: counted into the property rollup
// only — never spooled, never forwarded to Umami, not counted against the daily quota (C-137, decision D5).
var countedOnly = set("sign_requested", "sign_approved", "sign_rejected", "tx_submitted", "smart_wallet_created", "passkey_used",
	"walletconnect_request")

// rollupKey maps a v1 wire key to its rollup key (§a.3.1 table; `net` is the network column, not a property key).
var rollupKey = map[string]string{
	"wt": "wallet", "ck": "connect_kind", "sk": "sign_kind", "ec": "error_class", "rc": "result_class",
	"dur": "duration", "out": "outcome", "po": "passkey_op",
	"fr": "failure_reason", "wc": "wallet_context", "ws": "wc_state", "wm": "wc_method",
}

// placement is the field placement per v1 event (§a.3.1): the wire keys the event may carry, and whether a missing
// `wt` / `net` is recorded as `unknown` (fields listed as optional are omitted when absent).
type placement struct {
	fields                    []string
	unknownWallet, unknownNet bool
}

var placements = map[string]placement{
	"wallet_modal_opened":  {},
	"wallet_modal_closed":  {fields: []string{"out", "wt"}}, // wt only when out = connected
	"wallet_selected":      {fields: []string{"wt"}, unknownWallet: true},
	"wallet_connect":       {fields: []string{"wt", "net", "ck", "wc"}, unknownWallet: true, unknownNet: true},
	"wallet_disconnect":    {fields: []string{"wt", "net"}, unknownWallet: true},
	"sign_requested":       {fields: []string{"wt", "net", "sk"}, unknownWallet: true, unknownNet: true},
	"sign_approved":        {fields: []string{"wt", "net", "sk", "dur"}, unknownWallet: true, unknownNet: true},
	"sign_rejected":        {fields: []string{"wt", "net", "sk", "dur", "ec"}, unknownWallet: true, unknownNet: true},
	"tx_submitted":         {fields: []string{"rc", "net", "wt"}, unknownNet: true},
	"smart_wallet_created": {fields: []string{"net", "wt"}, unknownNet: true},
	"passkey_used":         {fields: []string{"po", "net"}, unknownNet: true},
	// tracker 1.2.0
	"wallet_connect_failed": {fields: []string{"wt", "net", "fr", "wc"}, unknownWallet: true, unknownNet: true},
	"walletconnect_session": {fields: []string{"ws", "net", "wc"}, unknownNet: true},
	"walletconnect_request": {fields: []string{"wm", "net", "ws"}, unknownNet: true},
}

// Legacy (schema version 0, ADR-0029) → v1 (§a.3.1 "Legacy mapping").
var (
	legacyNames = map[string]struct{ name, ck string }{
		"wallet_modal_opened": {"wallet_modal_opened", ""}, "wallet_modal_closed": {"wallet_modal_closed", ""},
		"wallet_selected": {"wallet_selected", ""}, "wallet_connected": {"wallet_connect", "new"},
		"wallet_session_restored": {"wallet_connect", "restored"}, "wallet_disconnected": {"wallet_disconnect", ""},
		"sign_requested": {"sign_requested", ""}, "sign_completed": {"sign_approved", ""}, "sign_failed": {"sign_rejected", ""},
	}
	legacyWallets  = map[string]string{"varial": "freighter", "wallet_connect": "walletconnect", "hot_wallet": "hot", "other": "unknown"}
	legacyNetworks = map[string]string{"public": "mainnet", "testnet": "testnet", "futurenet": "futurenet", "other": "unknown"}
	legacyErrors   = map[string]string{"rejected": "user_rejected", "timeout": "timeout", "unsupported": "unsupported", "other": "unknown"}
)

// Stellar is a wallet event after legacy mapping and field placement.
type Stellar struct {
	Name    string            // v1 event name
	Network string            // network column: `net`, else `unknown`
	Props   map[string]string // rollup key → value (wallet, connect_kind, …; never network)
	// HasNet: `net` is placed for this event (it then goes to Umami `data.network` for forwarded events).
	HasNet bool
	// Stripped: the event carried fields its name does not allow; they were discarded (drop/profile_field_stripped).
	Stripped bool
}

// CountedOnly reports whether the event is never spooled or forwarded (C-137).
func (s Stellar) CountedOnly() bool { return countedOnly[s.Name] }

// wireFields returns the v1 wire fields of a wallet event: v1 events as sent, legacy events mapped (§a.3.1).
func wireFields(e Event) (name string, f map[string]string) {
	f = map[string]string{}
	put := func(k, v string) {
		if v != "" {
			f[k] = v
		}
	}
	if e.SV == 1 {
		put("wt", e.WT)
		put("net", e.Net)
		put("ck", e.CK)
		put("sk", e.SK)
		put("ec", e.EC)
		put("rc", e.RC)
		put("dur", e.Dur)
		put("out", e.Out)
		put("po", e.PO)
		put("fr", e.FR)
		put("wc", e.WC)
		put("ws", e.WS)
		put("wm", e.WM)
		return e.N, f
	}
	m := legacyNames[e.N]
	if e.WID != "" {
		w := e.WID
		if x, ok := legacyWallets[w]; ok {
			w = x
		}
		put("wt", w)
	}
	put("net", legacyNetworks[e.Net])
	put("ck", m.ck)
	put("sk", e.SK)
	put("dur", e.Dur)
	put("out", e.Out)
	put("ec", legacyErrors[e.Err])
	return m.name, f
}

// ToStellar maps a parsed `wl` event (legacy or v1) to the v1 vocabulary and applies the field placement of §a.3.1.
// It never fails: the parser has already admitted closed lists only.
func ToStellar(e Event) Stellar {
	name, f := wireFields(e)
	pl := placements[name]
	allowed := map[string]bool{}
	for _, k := range pl.fields {
		allowed[k] = true
	}
	if name == "wallet_modal_closed" && f["out"] != "connected" {
		delete(allowed, "wt") // wallet only when the modal closed connected
	}
	s := Stellar{Name: name, Network: "unknown", Props: map[string]string{}}
	for k, v := range f {
		if !allowed[k] {
			// Legacy events always carried a connect kind by mapping (`ck`), which is placed for wallet_connect only.
			if !(k == "ck" && e.SV != 1) {
				s.Stripped = true
			}
			continue
		}
		if k == "net" {
			s.Network, s.HasNet = v, true
			continue
		}
		s.Props[rollupKey[k]] = v
	}
	if pl.unknownWallet && allowed["wt"] && s.Props["wallet"] == "" {
		s.Props["wallet"] = "unknown"
	}
	if name == "wallet_modal_closed" && allowed["wt"] && s.Props["wallet"] == "" {
		s.Props["wallet"] = "unknown"
	}
	if pl.unknownNet && !s.HasNet {
		s.HasNet = true // recorded as unknown (§a.3.1: a missing net is never a rejection)
	}
	return s
}

// UmamiData is the `data` of a forwarded wallet event: present fields under their rollup keys (§c.2).
func (s Stellar) UmamiData() map[string]any {
	d := map[string]any{}
	for k, v := range s.Props {
		d[k] = v
	}
	if s.HasNet {
		d["network"] = s.Network
	}
	if len(d) == 0 {
		return nil
	}
	return d
}

// PropRows are the property cells one accepted event adds (§a.3.1, §d.3): `_total`/`all` plus one per property.
func (s Stellar) PropRows() [][2]string {
	rows := [][2]string{{"_total", "all"}}
	for k, v := range s.Props {
		rows = append(rows, [2]string{k, v})
	}
	return rows
}
