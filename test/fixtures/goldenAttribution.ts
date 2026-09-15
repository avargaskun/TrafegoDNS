// @ts-nocheck
const containers = [
  {
    Id: '01'.repeat(32),
    Names: ['/app-worker'],
    Labels: {}
  },
  {
    Id: '02'.repeat(32),
    Names: ['/app-exporter'],
    Labels: { 'traefik.enable': 'true' }
  },
  {
    Id: '03'.repeat(32),
    Names: ['/app'],
    Labels: {
      'traefik.enable': 'true',
      'traefik.http.routers.app.rule': 'Host(`app.example.com`)',
      'traefik.http.routers.app-speed.rule': 'Host(`app-speed.example.com`)',
      'dns.manage': 'true'
    }
  },
  {
    Id: '04'.repeat(32),
    Names: ['/socketproxy-watcher'],
    Labels: { 'traefik.enable': 'true' }
  },
  {
    Id: '05'.repeat(32),
    Names: ['/watcher'],
    Labels: {
      'traefik.enable': 'true',
      'traefik.http.routers.watcher.rule': 'Host(`watcher.example.com`)',
      'dns.manage': 'true'
    }
  },
  {
    Id: '06'.repeat(32),
    Names: ['/desk'],
    Labels: {}
  },
  {
    Id: '07'.repeat(32),
    Names: ['/desk-vpn'],
    Labels: {
      'traefik.enable': 'true',
      'traefik.http.routers.desk.rule': 'Host(`desk.example.com`)',
      'traefik.http.routers.chat.rule': 'Host(`chat.example.com`)',
      'dns.manage': 'true'
    }
  },
  {
    Id: '08'.repeat(32),
    Names: ['/exporter-media-tv'],
    Labels: { 'traefik.enable': 'true' }
  },
  {
    Id: '09'.repeat(32),
    Names: ['/exporter-media-anime'],
    Labels: { 'traefik.enable': 'true' }
  },
  {
    Id: '10'.repeat(32),
    Names: ['/media-tv'],
    Labels: {
      'traefik.enable': 'true',
      'traefik.http.routers.media-tv.rule': 'Host(`media-tv.example.com`)',
      'dns.manage': 'true'
    }
  },
  {
    Id: '11'.repeat(32),
    Names: ['/media-anime'],
    Labels: {
      'traefik.enable': 'true',
      'traefik.http.routers.media-anime.rule': 'Host(`media-anime.example.com`)',
      'dns.manage': 'true'
    }
  },
  {
    Id: '12'.repeat(32),
    Names: ['/dash-image-renderer'],
    Labels: { 'traefik.enable': 'true' }
  },
  {
    Id: '13'.repeat(32),
    Names: ['/dash'],
    Labels: {
      'traefik.enable': 'true',
      'traefik.http.routers.dash.rule': 'Host(`dash.example.com`)',
      'dns.manage': 'true'
    }
  },
  {
    Id: '14'.repeat(32),
    Names: ['/proxy'],
    Labels: {
      'traefik.enable': 'true',
      'traefik.http.routers.api.rule': 'Host(`traefik.example.com`)',
      'traefik.http.routers.api.service': 'api@internal',
      'dns.manage': 'true'
    }
  },
  {
    Id: '15'.repeat(32),
    Names: ['/static'],
    Labels: {
      'traefik.enable': 'true',
      'traefik.http.routers.static-a.rule': 'Host(`static-a.example.com`)',
      'traefik.http.routers.static-a.service': 'static',
      'traefik.http.routers.static-b.rule': 'Host(`static-b.example.com`)',
      'traefik.http.routers.static-b.service': 'static',
      'traefik.http.routers.static-c.rule': 'Host(`static-c.example.com`)',
      'traefik.http.routers.static-c.service': 'static',
      'traefik.http.routers.static-d.rule': 'Host(`static-d.example.com`)',
      'traefik.http.routers.static-d.service': 'static'
    }
  },
  {
    Id: '16'.repeat(32),
    Names: ['/foo'],
    Labels: {
      'traefik.enable': 'true',
      'traefik.http.routers.foo.rule': 'Host(`foo.example.com`)',
      'dns.manage': 'true'
    }
  },
  {
    Id: '17'.repeat(32),
    Names: ['/admin'],
    Labels: {
      'traefik.enable': 'true',
      'traefik.http.routers.admin.rule': 'Host(`admin.example.com`)'
    }
  },
  {
    Id: '18'.repeat(32),
    Names: ['/blog'],
    Labels: {
      'traefik.enable': 'true',
      'traefik.http.routers.blog-admin.rule': 'Host(`blog-admin.example.com`)',
      'dns.manage': 'true'
    }
  },
  {
    Id: '19'.repeat(32),
    Names: ['/plain'],
    Labels: {
      'traefik.enable': 'true',
      'com.docker.compose.service': 'plain',
      'com.docker.compose.project': 'stack',
      'dns.manage': 'true'
    }
  },
  {
    Id: 'cafe'.repeat(16),
    Names: ['/beans'],
    Labels: { 'traefik.enable': 'true' }
  },
  {
    Id: '20'.repeat(32),
    Names: ['/cafe'],
    Labels: {
      'traefik.enable': 'true',
      'traefik.http.routers.cafe.rule': 'Host(`cafe.example.com`)',
      'dns.manage': 'true'
    }
  },
  {
    Id: '21'.repeat(32),
    Names: ['/right'],
    Labels: {
      'traefik.enable': 'true',
      'traefik.http.routers.shared.rule': 'Host(`shared.example.com`)',
      'dns.skip': 'true'
    }
  },
  {
    Id: '22'.repeat(32),
    Names: ['/left'],
    Labels: {
      'traefik.enable': 'true',
      'traefik.http.routers.shared.rule': 'Host(`shared.example.com`)',
      'dns.manage': 'true'
    }
  },
  {
    Id: '23'.repeat(32),
    Names: ['/legacy'],
    Labels: {
      'traefik.http.routers.legacy.rule': 'Host(`legacy.example.com`)',
      'dns.manage': 'true',
      'dns.proxied': 'false'
    }
  },
  {
    Id: '24'.repeat(32),
    Names: ['/disabled'],
    Labels: {
      'traefik.enable': 'false',
      'traefik.http.routers.disabled.rule': 'Host(`disabled.example.com`)',
      'dns.manage': 'true'
    }
  }
];

const routers = [
  { name: 'app@docker', provider: 'docker', entryPoints: ['https'], service: 'app', rule: 'Host(`app.example.com`)', status: 'enabled' },
  { name: 'app-speed@docker', provider: 'docker', entryPoints: ['https'], service: 'app', rule: 'Host(`app-speed.example.com`)', status: 'enabled' },
  { name: 'watcher@docker', provider: 'docker', entryPoints: ['https'], service: 'watcher', rule: 'Host(`watcher.example.com`)', status: 'enabled' },
  { name: 'desk@docker', provider: 'docker', entryPoints: ['https'], service: 'desk-vpn', rule: 'Host(`desk.example.com`)', status: 'enabled' },
  { name: 'chat@docker', provider: 'docker', entryPoints: ['https'], service: 'desk-vpn', rule: 'Host(`chat.example.com`)', status: 'enabled' },
  { name: 'media-tv@docker', provider: 'docker', entryPoints: ['https'], service: 'media-tv', rule: 'Host(`media-tv.example.com`)', status: 'enabled' },
  { name: 'media-anime@docker', provider: 'docker', entryPoints: ['https'], service: 'media-anime', rule: 'Host(`media-anime.example.com`)', status: 'enabled' },
  { name: 'dash@docker', provider: 'docker', entryPoints: ['https'], service: 'dash', rule: 'Host(`dash.example.com`)', status: 'enabled' },
  { name: 'api@docker', provider: 'docker', entryPoints: ['https'], service: 'api@internal', rule: 'Host(`traefik.example.com`)', status: 'enabled' },
  { name: 'dashboard@internal', provider: 'internal', entryPoints: ['https'], service: 'dashboard@internal', rule: 'Host(`dashboard.example.com`)', status: 'enabled' },
  { name: 'internal-api@file', provider: 'file', entryPoints: ['https'], service: 'internal-api', rule: 'Host(`files.example.com`) && PathPrefix(`/api`)', status: 'enabled' },
  { name: 'files@file', provider: 'file', entryPoints: ['https'], service: 'files', rule: 'Host(`files.example.com`)', status: 'enabled' },
  { name: 'static-a@docker', provider: 'docker', entryPoints: ['https'], service: 'static', rule: 'Host(`static-a.example.com`)', status: 'enabled' },
  { name: 'static-b@docker', provider: 'docker', entryPoints: ['https'], service: 'static', rule: 'Host(`static-b.example.com`)', status: 'enabled' },
  { name: 'static-c@docker', provider: 'docker', entryPoints: ['https'], service: 'static', rule: 'Host(`static-c.example.com`)', status: 'enabled' },
  { name: 'static-d@docker', provider: 'docker', entryPoints: ['https'], service: 'static', rule: 'Host(`static-d.example.com`)', status: 'enabled' },
  { name: 'https-foo@docker', provider: 'docker', entryPoints: ['https'], service: 'foo', rule: 'Host(`foo.example.com`)', status: 'enabled' },
  { name: 'blog-admin@docker', provider: 'docker', entryPoints: ['blog'], service: 'blog', rule: 'Host(`blog-admin.example.com`)', status: 'enabled' },
  { name: 'plain-stack@docker', provider: 'docker', entryPoints: ['https'], service: 'plain-stack', rule: 'Host(`plain.example.com`)', status: 'enabled' },
  { name: 'cafe@docker', provider: 'docker', entryPoints: ['https'], service: 'cafe', rule: 'Host(`cafe.example.com`)', status: 'enabled' },
  { name: 'shared@docker', provider: 'docker', entryPoints: ['https'], service: 'shared', rule: 'Host(`shared.example.com`)', status: 'enabled' },
  { name: 'legacy@docker', provider: 'docker', entryPoints: ['https'], service: 'legacy', rule: 'Host(`legacy.example.com`)', status: 'enabled' },
  { name: 'disabled@docker', provider: 'docker', entryPoints: ['https'], service: 'disabled', rule: 'Host(`disabled.example.com`)', status: 'enabled' }
];

const expectedOwners = {
  'app@docker': 'app',
  'app-speed@docker': 'app',
  'watcher@docker': 'watcher',
  'desk@docker': 'desk-vpn',
  'chat@docker': 'desk-vpn',
  'media-tv@docker': 'media-tv',
  'media-anime@docker': 'media-anime',
  'dash@docker': 'dash',
  'api@docker': 'proxy',
  'dashboard@internal': null,
  'internal-api@file': null,
  'files@file': null,
  'static-a@docker': 'static',
  'static-b@docker': 'static',
  'static-c@docker': 'static',
  'static-d@docker': 'static',
  'https-foo@docker': 'foo',
  'blog-admin@docker': 'blog',
  'plain-stack@docker': 'plain',
  'cafe@docker': 'cafe',
  'shared@docker': null,
  'legacy@docker': 'legacy',
  'disabled@docker': null
};

const expectedManagedHostnames = [
  'app-speed.example.com',
  'app.example.com',
  'blog-admin.example.com',
  'cafe.example.com',
  'chat.example.com',
  'dash.example.com',
  'desk.example.com',
  'foo.example.com',
  'legacy.example.com',
  'media-anime.example.com',
  'media-tv.example.com',
  'plain.example.com',
  'traefik.example.com',
  'watcher.example.com'
];

const expectedExcludedHostnames = ['shared.example.com'];

const expectedAmbiguousRouters = ['shared@docker'];

const expectedFallbackRouters = ['legacy@docker'];

export {
  containers,
  routers,
  expectedOwners,
  expectedManagedHostnames,
  expectedExcludedHostnames,
  expectedAmbiguousRouters,
  expectedFallbackRouters
};
