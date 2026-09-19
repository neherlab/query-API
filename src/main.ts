import { loadSchema } from './schema/index.js';
import './styles.css';
import { App } from './ui/app.js';

async function boot(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const source = await loadSchema(params.get('schema'));
  const container = document.getElementById('app');
  if (!container) throw new Error('missing #app');

  new App(container, {
    source,
    initialQuery: params.get('q') ?? '',
    initialOrganism: params.get('organism'),
  });
}

void boot();
