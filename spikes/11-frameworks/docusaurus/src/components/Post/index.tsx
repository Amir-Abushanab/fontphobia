import Layout from '@theme/Layout';
import {useLocation} from '@docusaurus/router';

export default function Post() {
  const id = useLocation().pathname.split('/').filter(Boolean).pop();
  return (
    <Layout title={`Post ${id}`}>
      <main style={{padding: '2rem'}}>
        <h1>Post {id}</h1>
        <p style={{fontFamily: 'Fraunces, serif'}}>Dynamic post (Fraunces)</p>
      </main>
    </Layout>
  );
}
