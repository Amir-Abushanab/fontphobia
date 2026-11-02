import adapterStatic from '@sveltejs/adapter-static';
import adapterNode from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, type Plugin } from 'vite';

// SK_ADAPTER=node -> adapter-node (server); default adapter-static.
const useNode = process.env.SK_ADAPTER === 'node';
const base = useNode ? adapterNode() : adapterStatic();

// Wrapping the adapter: adapt() runs once, after prerendering, so all HTML exists.
const adapter = {
	...base,
	async adapt(builder: any) {
		console.log('[probe] adapter.adapt start', JSON.stringify(builder.prerendered.paths));
		await base.adapt(builder);
		console.log('[probe] adapter.adapt done');
	}
};

const probe: Plugin = {
	name: 'probe',
	closeBundle() {
		// @ts-ignore
		console.log('[probe] closeBundle', this.environment?.name ?? '-');
	}
};

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter
		}),
		probe
	]
});
