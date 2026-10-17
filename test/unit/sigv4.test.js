import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signV4, uriEncode, amzDate, sha256Hex, EMPTY_SHA256 } from '../../plugins-official/storage-s3/sigv4.js';

// AWS's Signature Version 4 test suite (aws4_testsuite, as botocore ships it, fetched 2026-10-16).
const SUITE = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', region: 'us-east-1', service: 'service', date: '20150830T123600Z' };
const HOST = { host: 'example.amazonaws.com', 'x-amz-date': '20150830T123600Z' };
const U = '-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** @type {[string, string, string, [string, string][], Record<string, string>, string, string][]} name, method, path, query, headers, body, signature */
const CASES = [
  ['get-vanilla', 'GET', '/', [], {}, '', '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31'],
  ['get-vanilla-query-order-key-case', 'GET', '/', [['Param2', 'value2'], ['Param1', 'value1']], {}, '', 'b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500'],
  ['get-vanilla-query-unreserved', 'GET', '/', [[U, U]], {}, '', '9c3e54bfcdf0b19771a7f523ee5669cdf59bc7cc0884027167c21bb143a40197'],
  ['get-vanilla-query-order-encoded', 'GET', '/', [['Param-3', 'Value3'], ['Param', 'Value2'], ['ሴ', 'Value1']], {}, '', '371d3713e185cc334048618a97f809c9ffe339c62934c032af5a0e595648fcac'],
  ['get-vanilla-utf8-query', 'GET', '/', [['ሴ', 'bar']], {}, '', '2cdec8eed098649ff3a119c94853b13c643bcf08f8b0a1d91e12c9027818dd04'],
  ['get-utf8', 'GET', '/ሴ', [], {}, '', '8318018e0b0f223aa2bbf98705b62bb787dc9c0e678f255a891fd03141be5d85'],
  ['get-unreserved', 'GET', `/${U}`, [], {}, '', '07ef7494c76fa4850883e2b006601f940f8a34d404d0cfa977f52a65bbf5f24f'],
  ['get-header-value-trim', 'GET', '/', [], { 'My-Header1': ' value1', 'My-Header2': ' "a   b   c"' }, '', 'acc3ed3afb60bb290fc8d2dd0098b9911fcaa05412b367055dee359757a9c736'],
  ['post-header-key-sort', 'POST', '/', [], { 'My-Header1': 'value1' }, '', 'c5410059b04c1ee005303aed430f6e6645f61f4dc9e1461ec8f8916fdf18852c'],
  ['post-vanilla-query', 'POST', '/', [['Param1', 'value1']], {}, '', '28038455d6de14eafc1f9222cf5aa6f1a96197d7deb8263271d420d138af7f11'],
  ['post-x-www-form-urlencoded', 'POST', '/', [], { 'Content-Type': 'application/x-www-form-urlencoded' }, 'Param1=value1', 'ff11897932ad3f4e8b18135d722051e5ac45fc38421b1da7b9d196a0fe09473a'],
];

test("Signature Version 4 matches AWS's own test suite", async () => {
  for (const [name, method, path, query, headers, body, signature] of CASES) {
    const payloadHash = await sha256Hex(new TextEncoder().encode(body));
    const got = await signV4({ ...SUITE, method, path, query, headers: { ...HOST, ...headers }, payloadHash });
    assert.equal(got.signature, signature, name);
  }
  const vanilla = await signV4({ ...SUITE, method: 'GET', path: '/', headers: HOST, payloadHash: EMPTY_SHA256 });
  assert.equal(vanilla.canonicalRequest, 'GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(vanilla.stringToSign, 'AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\nbb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63');
  assert.equal(vanilla.authorization, 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
});

test('uriEncode is RFC 3986 as SigV4 wants it; S3 paths keep their slashes; amzDate', async () => {
  assert.equal(uriEncode(U), U);
  assert.equal(uriEncode('a b+c/d=é*~'), 'a%20b%2Bc%2Fd%3D%C3%A9%2A~');
  assert.equal(uriEncode('/trips/annai/a b+c.annai.zip', false), '/trips/annai/a%20b%2Bc.annai.zip');
  assert.equal(amzDate(new Date(Date.UTC(2026, 9, 16, 18, 4, 5, 999))), '20261016T180405Z');
  assert.equal(EMPTY_SHA256, await sha256Hex(new Uint8Array()));
});
