(() => {
  const btn = document.getElementById('tick');
  const out = document.getElementById('counter');
  let n = 0;
  btn.addEventListener('click', () => {
    n += 1;
    out.textContent = String(n);
  });
})();
