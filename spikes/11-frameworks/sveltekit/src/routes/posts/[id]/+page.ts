import type { EntryGenerator, PageLoad } from './$types';

export const entries: EntryGenerator = () => [{ id: '1' }, { id: '2' }];
export const load: PageLoad = ({ params }) => ({ id: params.id });
