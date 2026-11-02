<script lang="ts">
	import '@fontsource-variable/inter';
	import favicon from '#lib/assets/favicon.svg';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<link rel="preconnect" href="https://fonts.googleapis.com" />
	<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:wght@400..700&display=swap" />
</svelte:head>

<nav><a href="/">Home</a> · <a href="/about">About</a> · <a href="/posts/1">Post 1</a> · <a href="/posts/2">Post 2</a></nav>
<div style="font-family: 'Inter Variable', sans-serif">{@render children()}</div>
