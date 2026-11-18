# Site builders and CMSs: WordPress, Webflow, Framer, Ghost

Every site builder has a place for code that goes into the `<head>` of every page. Paste the portal's snippet there,
unchanged, and publish. The steps around it (website, dev origin, footprint, domain verification) are those of
[plain HTML](web-html.md).

**What is tested and what is not.** The snippet itself is tested by the repository's browser tests: a page carrying
it, served as static HTML, is counted exactly once per page load in a real browser, and its custom events arrive
([plain HTML](web-html.md), example site `examples/html` in the repository). The builders below are not run by the
tests: they are third-party services. What they have to do is only to put the tag into the page unchanged; the check
at the end of this page tells you whether yours did.

## The snippet and how its integrity check works

Copy it from the portal (site → **Snippet**, format *HTML*); it carries your site key:

```html
<script
  src="https://ingest-a.example-analytics.org/lib/1.2.0/standard.js"
  integrity="sha384-9cCOUUPE6uUu1Hwc1k3dMe7p64S2BpjVx5u4FoYVgXXomF744QWb1rSVHZqK7MRu"
  crossorigin="anonymous"
  data-site="YOUR_22_CHAR_SITE_KEY"
  defer
></script>
```

`integrity` is the hash of the exact tracker file of that version (Subresource Integrity). The browser downloads the
file, hashes it and runs it only if the hash matches, so nobody — not even the analytics host — can change the code
that runs on your site without you changing the snippet. `crossorigin="anonymous"` is what lets the browser check the
hash of a file from another host; without it the check fails.

What this means in a site builder:

- **Paste the whole tag, attributes included.** Without `crossorigin` the browser refuses the file, without
  `data-site` the tracker does not start, and without `integrity` the protection is gone.
- **Exclude the tracker from "optimisation".** Performance features and plugins that combine, minify, delay,
  self-host or proxy third-party scripts change the file or the way it is loaded; the hash no longer matches and the
  browser refuses the file. Add the tracker's URL (or `ingest-a.example-analytics.org`) to the plugin's exclusion
  list.
- **Cloudflare Rocket Loader:** add `data-cfasync="false"` to the tag, **before** `src` (Cloudflare requires that
  order), so Rocket Loader leaves it alone.
- **Upgrading** means pasting the new snippet: the version and the hash change together. The old version keeps
  working until you do.

If the hash does not match, the browser does not run the tracker: analytics stops, your site keeps working.

## WordPress

Self-hosted WordPress: add a must-use plugin, so that the tag stays when you change or update your theme. Create the
file `wp-content/mu-plugins/site-analytics.php` (WordPress loads every PHP file directly in that directory,
automatically, on every site):

```php
<?php
// Adds the analytics snippet to the <head> of every page.
add_action('wp_head', function () {
    ?>
<script
  src="https://ingest-a.example-analytics.org/lib/1.2.0/standard.js"
  integrity="sha384-9cCOUUPE6uUu1Hwc1k3dMe7p64S2BpjVx5u4FoYVgXXomF744QWb1rSVHZqK7MRu"
  crossorigin="anonymous"
  data-site="YOUR_22_CHAR_SITE_KEY"
  defer
></script>
    <?php
});
```

The `wp_head` action runs inside `<head>` in themes that call `wp_head()`, as standard WordPress themes do. If you
cannot add files (some managed hosts), a "header and footer code" plugin that pastes HTML into the head as written
works the same way; check that it does not move the tag into a combined or delayed script. Then exclude the tracker
URL in caching and optimisation plugins (see above).

## Webflow

In the site settings, open **Custom code** and paste the snippet into the head code field; save and publish the
site. Custom code takes effect when the site is published, so check the published URL, not the Designer. If the
field is not available, check whether your Webflow plan includes custom code.

## Framer

Project settings → **Custom Code** → **Add Script**: paste the snippet, place it in the page's head, choose **Run on
every page visit**, then publish. Framer may navigate between pages without a full page load; the tracker
follows navigations through the History API, so each page change is counted once either way.

## Ghost

Settings → Advanced → **Code injection** → **Site header**: paste the snippet and save. Ghost outputs the site header
code inside `<head>` on every page of the site.

## Check it

1. Open the published page (not an editor preview) and view its source: the tag must be there exactly as pasted,
   with `integrity`, `crossorigin` and `data-site`.
2. In the browser's developer tools, the console must show no error about an integrity mismatch for
   `standard.js`, and the network panel shows a request to `ingest-a.example-analytics.org/v1/c` (or the `-b` host).
3. About a minute later the portal's Installation page (site → **Installation**) shows the page view. Verify the
   domain (site → **Domains**) so that page views count as *verified*.

Testing in Brave or with Global Privacy Control on? The tracker then sends nothing, by design; an ad blocker may
block it. Use a browser profile without them ([troubleshooting](troubleshooting.md)).

**Content Security Policy** (if your builder lets you set one): `script-src https://ingest-a.example-analytics.org`
and `connect-src https://ingest-a.example-analytics.org https://ingest-b.example-analytics.net`.
