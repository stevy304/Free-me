import { noticeMail, signInCodeMail } from '../src/mail/mail.service';

test('sign-in messages keep the code in the plain text and render the branded layout', () => {
  const message = signInCodeMail('viewer@example.test', '123456', 10);
  expect(message.text).toContain('Your Free Me sign-in code is 123456');
  expect(message.html).toContain('<html lang="en">');
  expect(message.html).toContain('123456');
});

test('notices escape user content and omit unsafe action links', () => {
  const message = noticeMail('creator@example.test', '<Review>', ['<img src=x>'], { label: 'Open', url: 'javascript:alert(1)' });
  expect(message.html).toContain('&lt;Review&gt;');
  expect(message.html).toContain('&lt;img src=x&gt;');
  expect(message.html).not.toContain('javascript:');
  expect(message.text).toContain('<img src=x>');
});
