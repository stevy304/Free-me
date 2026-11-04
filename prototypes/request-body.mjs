export async function* boundedBody(request, limit, message) {
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) {
      request.resume();
      throw Object.assign(new Error(message), { status: 413 });
    }
    yield chunk;
  }
  if (size === 0) throw Object.assign(new Error('The request body is empty.'), { status: 400 });
}
