<!-- src/routes/+page.svelte — a custom event -->
<script lang="ts">
import { analytics } from "#lib/analytics.ts";
</script>

<main>
  <h1>Home</h1>
  <button type="button" onclick={() => analytics()?.track("signup", { plan: "free" })}>Sign up</button>
</main>
