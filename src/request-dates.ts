export const lastDay = (end: number) => new Date((end - 1) * 1000).toISOString().slice(0, 10);
