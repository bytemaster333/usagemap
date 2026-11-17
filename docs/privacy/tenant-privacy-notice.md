# Privacy-notice snippets for tenants

> **Not legal advice.** Engineer-drafted text for tenants to adapt; not reviewed by
> counsel. You (the tenant) are the controller: you are responsible for your privacy notice, and you should have it
> checked for your jurisdiction. Replace everything in `<ANGLE BRACKETS>`. Do not add claims such as "certified",
> "approved by the CNIL" or "100 % GDPR compliant". The text describes the design as decided in the design-decision register
> C-01…C-112 (`docs/adr/README.md`); `<OPERATOR-ENTITY>` below is the service operator that hosts the
> service for you as your processor.

Which snippet to use:

| Your site uses | Use |
|---|---|
| `standard` profile | §1 (short) or §2 (long, `standard`) |
| `strict` profile | §1 (short) or §3 (long, `strict`) |
| Consent-gated mode (`consent: "required"`) — required for visitors in jurisdictions classed "Not without opt-in" | the profile's text **plus** §3a, and the analytics entry in your consent tool |
| API analytics only | §5 |
| Visitors in Switzerland, the UK, Japan, California, Türkiye, Quebec | add the matching part of §6 |

Every notice must include the opt-out link (§4). Sentences in `<ANGLE BRACKETS>` depend on your settings
(`visitor_id`, `anonymous_reports`, public stats, retention); delete the ones that do not apply.

**French audience-measurement criteria (CNIL exemption).** Name them as your route for access to the device only if
your site sends **page views alone** — no custom events and no wallet events. Whether custom and wallet events fit the
limit of three event types in the CNIL self-assessment is an open question for counsel; until it is answered, this
text claims those criteria only for page-view-only sites (C-71). Sites that also send events should name another
route from the jurisdiction statement or use the consent-gated mode (§3a).

## 1. Short form (either profile)

> **Analytics.** We measure how our website is used with privacy-preserving analytics operated for us by
> `<OPERATOR-ENTITY>` in the European Union. No cookies are set and your IP address is never stored; it is used only
> for a moment to determine your country `<and to count visits for a single day — delete if no visitor identifier is
> used>`. We use the results only to understand and improve our site, and we share only anonymous, rounded totals with
> the SCF ecosystem programme `<and publish them — if you switched public stats on>`. You can opt out at any time:
> **<a href="#" data-optout>Do not measure my visits</a>**. Browsers that send a Global Privacy Control or Do Not Track
> signal are not measured. More: `<link to long form>`.

## 2. Long form — `standard` profile

> **Website analytics**
>
> **What we do.** To understand how our website is used and to improve it, we measure visits with an analytics service
> operated on our behalf by `<OPERATOR-ENTITY>`, `<OPERATOR-ADDRESS>` (our processor). The service runs on servers in
> the European Union.
>
> **What is collected.** When you load a page, a small script sends: the page path (without anything after `?` or `#`;
> before storage, values in the path that look like account addresses, e-mail addresses, tokens or other identifiers
> are replaced by placeholders), the host name of the site that linked to us, a coarse screen-width class, your
> browser's main language (e.g. "en"), and, if you interact with certain features, the name of that interaction (for
> example "wallet connected", with the wallet's name and the network — never your wallet address; when you sign or
> submit a transaction, only a daily count is kept, never a record attached to your visit). The script also
> solves a small computational puzzle so that the service can tell browsers from automated traffic. The server also
> receives your IP address and browser identification, as with any web request.
>
> **What happens to your IP address.** It is kept in memory only, for the duration of the request: it is shortened, used
> to look up your country, and combined with your browser identification and a secret key that changes every day to
> create a code that lets us count you once per day on this site. The IP address and full browser identification are
> then discarded and never written to disk or logs. The daily key is destroyed every day at midnight UTC; after that,
> nobody — including us and the service operator — can link the stored data to your IP address or device.
>
> **What is stored.** Page, referring site, country, browser and operating system family and version, device type,
> screen-width class, language, time, and the daily code — kept for `<90>` days, then deleted. Daily totals that
> contain no information about individuals are kept for longer. `<Our own reports show counts rounded to the nearest
> ten and group small numbers together, so that no individual visit can be singled out — delete this sentence if you
> switch anonymous reports off.>`
>
> **No cookies, no tracking across sites.** The script sets no cookies and stores nothing on your device, except a note
> of your choice if you opt out. The daily code is different on every website and every day, so you cannot be followed
> across sites or over time.
>
> **Purpose and legal basis.** Measuring and improving our website, and keeping the statistics accurate (filtering bots).
> Our legal basis is our legitimate interest `<Art. 6(1)(f) GDPR / local equivalent>`; for access to your device we
> rely on `<the exemption applicable to you — see the service operator's jurisdiction statement; name the French
> (CNIL) audience-measurement exemption only if your site sends page views alone (see the note above)>`.
>
> **Who receives what.** Our processor `<OPERATOR-ENTITY>` and its hosting providers in the EU. The Stellar Community
> Fund receives only anonymous, rounded totals for our project — never data about individual visits — to evaluate
> projects it supports. `<Rounded daily totals for our site are also public — if you switched public stats on.>` No
> data is sold or used for advertising.
>
> **Your choices and rights.** You can object at any time with the link below; Global Privacy Control and Do Not Track
> signals are honoured automatically. `<If you use the consent-gated mode: add §3a.>` Because no information that identifies you is stored, we are usually not in a
> position to find your visits in our data (Art. 11 GDPR). If you believe a web address on our site contained personal
> information about you (for example in a link you received), contact `<CONTACT>` and we will delete it.
>
> **Opt out:** <a href="#" data-optout>Do not measure my visits on this site</a>

## 3. Long form — `strict` profile

Use §2 with these replacements:

- **What is collected:** "When you load a page, a small script sends only the page path (without anything after `?` or
  `#`; identifiers in the path are replaced by placeholders before storage) and solves a small computational puzzle
  that lets the service tell browsers from automated traffic. The server also receives your IP address and browser
  identification, as with any web request."
- **What happens to your IP address** (`strict` has no visitor identifier unless you turned it on): "It is kept in
  memory only, for the duration of the request: it is shortened and used to look up your country and to check for
  automated traffic. No code that could recognise you is created. The IP address and full browser identification are
  then discarded and never written to disk or logs." If you deliberately turned the identifier on, keep the §2
  paragraph instead.
- **What is stored:** "Page, country, browser and operating system family and version, device type and time" — remove
  referring site, screen-width class, language and (unless you turned the identifier on) the daily code; and say "we
  count page views, not visitors".
- **No tracking across sites:** keep the §2 paragraph, without the sentence about the daily code if no identifier is
  used.
- If you use `standard` but switch the identifier off for some countries: add "For visitors from `<countries>`, no
  daily code is created; we only count page views, by country and device type."

## 3a. Consent-gated mode — additional wording

Use this when the tracker runs with `consent: "required"` (it sends nothing until your consent tool calls
`grantConsent()`, and stops on `revokeConsent()`). This is the route for visitors in jurisdictions that the
jurisdiction statement classes "Not without opt-in"; collecting and recording valid consent is your responsibility,
through your own consent tool. Replace the "Purpose and legal basis" and "Your choices" paragraphs of §2/§3 with:

> **Your consent.** We only measure your visits if you agree. Until you give your consent in our consent banner
> `<name of your consent tool / settings link>`, the analytics script sends nothing at all. If you agree, the data
> described above is collected on the basis of your consent `<Art. 6(1)(a) GDPR / local equivalent>`. You can withdraw
> your consent at any time, as easily as you gave it, through `<settings link>`; measurement then stops immediately.
> Withdrawing does not affect measurement that took place before. Global Privacy Control and Do Not Track signals stop
> measurement even if you have consented.

In your consent tool, describe the analytics entry with the same purpose, recipient (`<OPERATOR-ENTITY>`, in the EU)
and retention (`<90>` days for individual visits) as the notice. The opt-out link (§4) may stay on your privacy page;
it then works in addition to withdrawal of consent.

## 4. Opt-out link — instructions

The opt-out stores one flag in the visitor's browser for your site and stops all measurement there; opting in again
removes it. Place the link on your privacy page (and optionally in your footer).

**Script-tag installation** (global object name is `<TRACKER_GLOBAL>` — final name set by the release):

```html
<a href="#" id="analytics-optout">Do not measure my visits on this site</a>
<script>
  document.getElementById('analytics-optout').addEventListener('click', function (e) {
    e.preventDefault();
    window.<TRACKER_GLOBAL>.optOut();
    this.textContent = 'Your visits are no longer measured on this site.';
  });
</script>
```

If your Content-Security-Policy forbids inline scripts, put the listener in your own bundled JavaScript.

**npm installation:**

```js
import { optOut, optIn } from '@SCOPE/tracker';
document.querySelector('[data-optout]')?.addEventListener('click', (e) => { e.preventDefault(); optOut(); });
```

Notes for your notice and support team:

- The choice is per browser and per site; clearing site data or using another browser resets it.
- Global Privacy Control and Do Not Track are honoured as well, but they do not replace the link (the UK regulator
  says you must not rely solely on browser settings).
- If your site needs consent (see the jurisdiction statement), do not use the opt-out alone: run the tracker in the
  consent-gated mode (`consent: "required"`) and call `grantConsent()` / `revokeConsent()` from your consent tool, or
  load the tracker script only after your consent tool records consent; use the wording in §3a.

## 5. API analytics only

> **Service analytics.** Our API sends technical usage metrics — the endpoint pattern (with identifiers such as account
> addresses replaced by placeholders), the request method, the response status and the response time — to an analytics
> service operated for us by `<OPERATOR-ENTITY>` in the EU. No IP addresses, user identifiers, request contents or
> query parameters of API users are sent or stored. The SCF ecosystem programme receives only anonymous totals.

## 6. Additions per jurisdiction

### Switzerland (FADP; TCA Art. 45c; FDPIC Guidelines v1.1)

Notice and a right to refuse are mandatory. Add, in the language of your site:

> We use this technology to produce anonymous statistics about the use of our website. You may refuse it: use the
> link "<em>Do not measure my visits on this site</em>" above, or enable Global Privacy Control / Do Not Track in your
> browser. Refusing has no effect on your use of the site.

### United Kingdom (PECR Sch. A1 para 5)

Clear and comprehensive information plus a simple, free means of objecting are conditions of the statistical
exception. Add:

> We use this analytics solely to collect statistical information about how our website is used, in order to improve
> it. You can object free of charge at any time with the link "<em>Do not measure my visits on this site</em>"; if you
> object, no information is collected from your device. `<If you are a UK site and the SCF sharing question is not
> resolved for you: describe the sharing of anonymous totals with the SCF ecosystem programme, or take advice —
> jurisdictions.md §2.>`

If you set `visitor_id = off_in: [GB]` (the mitigation for the open "automatically emitted information" question),
replace the daily-code sentences for UK visitors with the `strict` wording of §3.

### Japan (Telecommunications Business Act — external transmission rule)

For in-scope services (e.g. SNS, search, e-commerce, information-providing sites), notify or publish **in Japanese**,
**before** the information is sent, what is sent, for what purpose and to whom. Draft (needs native-speaker and legal
review):

> **利用者情報の外部送信について**
>
> 当サイトでは、サイトの利用状況を統計的に把握し改善に役立てるため、以下のとおり利用者に関する情報を外部に送信しています。
>
> | 送信先 | 送信される情報 | 利用目的 |
> |---|---|---|
> | `<OPERATOR-ENTITY>`（ウェブ解析サービスの運営者・所在地：欧州連合） | 閲覧したページのパス（「?」以降を除く）、参照元サイトのホスト名、画面幅の区分、ブラウザの主言語、IP アドレスおよびブラウザの種類に関する情報（IP アドレス等は国の判定、当日限りの統計用識別子の生成、ボットの判定のためにのみ一時的に使用され、保存されません）、サイト上の特定の操作の名称 | 当サイトのアクセス解析（閲覧数、日ごとの訪問者数、参照元、滞在時間、直帰率、国別・端末別の統計）および統計の正確性の確保 |
>
> 送信を希望されない場合は、「<em>計測を停止する</em>」リンクから停止できます。

(English gloss: "External transmission of user information — to understand and improve use of this site we send the
following information about users to the recipient below: recipient / information sent / purpose … You can stop the
transmission with the 'stop measurement' link.")

### California (CCPA)

> We do not sell or share personal information. Analytics data is processed by our service provider `<OPERATOR-ENTITY>`
> solely to provide analytics to us. Data is stored in deidentified form once the daily key is destroyed, and we and our
> service provider commit not to attempt to re-identify it.

### Türkiye (KVKK)

Provide the information notice (aydınlatma metni) required by KVKK Art. 10 in Turkish, naming yourself as controller,
the service operator as processor, the purposes above, the transfer abroad (EU) and its legal mechanism (standard contract
notified to the KVKK Board), and the data subject's rights. `<Turkish translation to be prepared and reviewed by Turkish
counsel.>`

### Quebec (Law 25)

On a cautious reading, s. 8.1 requires technology that can identify, locate or profile to be **off by default**, so a
notice alone may not suffice. Quebec cannot be detected from country data, so decide for all of Canada: use the
consent-gated mode (§3a, in French) for your site if Canadian traffic is material, or use the `strict` profile without
a visitor identifier (its default) or `visitor_id = off_in: [CA]`. If you keep analytics on without consent, add a
French notice:

> **Mesure d'audience.** Nous mesurons l'utilisation de notre site au moyen d'un outil d'analyse respectueux de la vie
> privée exploité pour notre compte par `<OPERATOR-ENTITY>` dans l'Union européenne. Aucun témoin (cookie) n'est
> déposé et votre adresse IP n'est jamais conservée ; elle sert uniquement, un court instant, à déterminer votre pays
> `<et à compter les visites pour une seule journée — à supprimer si aucun identifiant de visiteur n'est utilisé>`. Vous pouvez désactiver cette mesure à tout moment :
> « <em>Ne pas mesurer mes visites</em> ».

### Brazil (LGPD)

Keep a documented legitimate-interest assessment (LIA) and reference it in your notice; transfers to the EU rely on the
EU–Brazil mutual adequacy (January 2026).
