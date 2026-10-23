import { test } from 'node:test';
import assert from 'node:assert/strict';
import { xmlElements, xmlText } from '../../src/core/xml.js';
import { cpuMs } from './cpu.js';

const LIST = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>trips</Name><Prefix>annai/</Prefix><KeyCount>2</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>true</IsTruncated>
<Contents><Key>annai/a&amp;b.annai.zip</Key><LastModified>2026-10-16T18:04:05.000Z</LastModified><ETag>&quot;abc&quot;</ETag><Size>2048</Size><StorageClass>STANDARD</StorageClass></Contents>
<Contents><Key>annai/c.annai</Key><LastModified>2026-10-17T08:00:00.000Z</LastModified><Size>10</Size></Contents>
<NextContinuationToken>1ueGcxLPRx1Tr/XYExHnhbYLgveDs2J/wm36Hy4vbOwM=</NextContinuationToken></ListBucketResult>`;

const ERROR = '<?xml version="1.0" encoding="UTF-8"?><Error><Code>SignatureDoesNotMatch</Code><Message>The request signature we calculated does not match</Message><Region>eu-west-1</Region></Error>';

const NEXTCLOUD = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns" xmlns:oc="http://owncloud.org/ns"><d:response><d:href>/remote.php/dav/files/me/annai/</d:href><d:propstat><d:prop><d:getlastmodified>Fri, 16 Oct 2026 18:04:05 GMT</d:getlastmodified><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response><d:response><d:href>/remote.php/dav/files/me/annai/annai-backup-x%20y.annai.zip</d:href><d:propstat><d:prop><d:getlastmodified>Fri, 16 Oct 2026 18:04:06 GMT</d:getlastmodified><d:getcontentlength>2048</d:getcontentlength><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;

const APACHE = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:ns0="DAV:"><D:response xmlns:lp1="DAV:" xmlns:lp2="http://apache.org/dav/props/"><D:href>/dav/annai/</D:href><D:propstat><D:prop><lp1:resourcetype><D:collection/></lp1:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response><D:response xmlns:lp1="DAV:"><D:href>/dav/annai/b.annai</D:href><D:propstat><D:prop><lp1:resourcetype/><lp1:getcontentlength>10</lp1:getcontentlength></D:prop></D:propstat></D:response></D:multistatus>`;

const PLAIN = '<multistatus xmlns="DAV:"><response><href>/x/</href></response><response><href>/x/y</href></response></multistatus>';

test("S3's list and error answers", () => {
  const contents = xmlElements(LIST, 'Contents');
  assert.deepEqual(contents.map((c) => [xmlText(c, 'Key'), xmlText(c, 'Size')]), [['annai/a&b.annai.zip', '2048'], ['annai/c.annai', '10']]);
  assert.equal(xmlText(LIST, 'IsTruncated'), 'true');
  assert.equal(xmlText(LIST, 'KeyCount'), '2', 'Key is not KeyCount');
  assert.equal(xmlText(LIST, 'NextContinuationToken'), '1ueGcxLPRx1Tr/XYExHnhbYLgveDs2J/wm36Hy4vbOwM=');
  assert.equal(xmlText(contents[0], 'ETag'), '"abc"');
  assert.equal(xmlText(LIST, 'Nothing'), null);
  assert.deepEqual([xmlText(ERROR, 'Code'), xmlText(ERROR, 'Region')], ['SignatureDoesNotMatch', 'eu-west-1']);
});

test('WebDAV multistatus answers, whatever their prefixes', () => {
  /** @type {[string, string[]][]} */
  const cases = [
    [NEXTCLOUD, ['/remote.php/dav/files/me/annai/', '/remote.php/dav/files/me/annai/annai-backup-x%20y.annai.zip']],
    [APACHE, ['/dav/annai/', '/dav/annai/b.annai']],
    [PLAIN, ['/x/', '/x/y']],
  ];
  for (const [xml, hrefs] of cases) assert.deepEqual(xmlElements(xml, 'response').map((r) => xmlText(r, 'href')), hrefs);
  const [folder, file] = xmlElements(NEXTCLOUD, 'response');
  assert.equal(xmlElements(folder, 'collection').length, 1);
  assert.equal(xmlElements(file, 'collection').length, 0);
  assert.equal(xmlText(file, 'getcontentlength'), '2048');
  assert.equal(xmlText(xmlElements(APACHE, 'response')[1], 'getcontentlength'), '10');
});

test('entities, CDATA, empty and self-closing elements, attributes', () => {
  assert.equal(xmlText('<a>&lt;b&gt; &#233; &#x263A; &apos;q&apos; &quot;r&quot; &amp;amp;</a>', 'a'), "<b> é ☺ 'q' \"r\" &amp;");
  assert.equal(xmlText('<a><![CDATA[<raw> & ok]]></a>', 'a'), '<raw> & ok');
  assert.equal(xmlText('<a/>', 'a'), '');
  assert.equal(xmlText('<x><a id="1"/><a id="2">two</a></x>', 'a'), '');
  assert.deepEqual(xmlElements('<x><a id="1"/><a id="2">two</a></x>', 'a'), ['', 'two']);
});

test("a server's broken or hostile answer can't make annai throw or stall", { timeout: 10_000 }, () => {
  assert.equal(xmlText('<a>&#x110000;&#9999999999;&#xD800;&#0;ok</a>', 'a'), '����ok');
  const flood = '<Key>'.repeat(200_000); // 1 MB of openings without a close
  const started = cpuMs();
  assert.deepEqual(xmlElements(flood, 'Key'), []);
  assert.equal(xmlText(flood, 'Key'), null);
  assert.ok(cpuMs() - started < 200, `${cpuMs() - started} ms of CPU`);
  const more = cpuMs();
  assert.equal(xmlElements(`<a>${'<![CDATA['.repeat(100_000)}</a>`, 'a').length, 1);
  xmlText(`<a>${'<![CDATA['.repeat(100_000)}</a>`, 'a');
  xmlText(`<a>${'<'.repeat(1_000_000)}</a>`, 'a');
  xmlText(`<a>${'&#'.repeat(500_000)}</a>`, 'a');
  xmlElements(`${'</Key'.repeat(200_000)}`, 'Key');
  assert.ok(cpuMs() - more < 1000, `${cpuMs() - more} ms of CPU`);
});
