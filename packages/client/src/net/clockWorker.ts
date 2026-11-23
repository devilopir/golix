let timer: ReturnType<typeof setTimeout> | undefined;

onmessage = (e: MessageEvent<number | null>) => {
  clearTimeout(timer);
  if (e.data !== null) timer = setTimeout(() => postMessage(null), e.data);
};
