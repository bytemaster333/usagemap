<!-- src/routes/+layout.svelte -->
<script lang="ts">
import { onMount } from "svelte";
import { analytics } from "#lib/analytics.ts";

let { children } = $props();
onMount(() => {
  analytics(); // once, in the browser; client-side navigations are followed through the History API
});
</script>

<nav><a href="/">Home</a> <a href="/about">About</a></nav>
{@render children()}
