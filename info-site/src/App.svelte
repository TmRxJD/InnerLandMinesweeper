<script lang="ts">
  import site from './site.json';
  const arcade = 'https://tmrxjd.github.io/tower-game-hub/';
</script>

<svelte:head>
  <title>{site.title} | Tower Arcade</title>
  <meta property="og:title" content={site.title} />
  <meta property="og:description" content={site.summary} />
  <meta property="og:type" content="website" />
</svelte:head>

<div class="site" style={`--accent:${site.accent}`}>
  <a class="skip" href="#main">Skip to main content</a>
  <header class="masthead">
    <a class="arcade-link" href={arcade}>Tower Arcade</a>
    <nav aria-label="Page sections"><a href="#about">About</a><a href="#how-to-play">How to play</a><a href="#controls">Controls</a></nav>
  </header>
  <main id="main" tabindex="-1">
    <section class="hero" aria-labelledby="game-title">
      <div>
        <h1 id="game-title">{site.title}</h1>
        {#if site.alias}<p class="alias">{site.alias}</p>{/if}
        <p class="premise">{site.premise}</p>
        <p class="summary">{site.summary}</p>
        <div class="hero-links">{#if site.playUrl}<a class="primary" href={site.playUrl}>Play {site.title}</a>{:else}<a class="primary" href="#how-to-play">How to play</a>{/if}<a class="quiet" href={arcade}>Explore the arcade</a></div>
      </div>
      <aside class="availability" aria-labelledby="status-title">
        <p class="genre">{site.genre}</p>
        <h2 id="status-title">{site.playUrl ? 'Play in your browser' : 'In development'}</h2>
        <p>{site.availability}</p>
        {#if !site.playUrl}<p class="preview-note">Gameplay images and videos will come later.</p>{/if}
      </aside>
    </section>
    <section class="content-section" id="about" aria-labelledby="about-title">
      <h2 id="about-title">About the game</h2>
      <div class="prose">
        {#each site.about as paragraph}<p>{paragraph}</p>{/each}
        <ul class="features">{#each site.features as feature}<li><strong>{feature.title}</strong><p>{feature.text}</p></li>{/each}</ul>
      </div>
    </section>
    <section class="content-section" id="how-to-play" aria-labelledby="play-title">
      <h2 id="play-title">How to play</h2>
      <ol class="steps">{#each site.steps as step}<li><h3>{step.title}</h3><p>{step.text}</p></li>{/each}</ol>
    </section>
    <section class="content-section" id="controls" aria-labelledby="controls-title">
      <h2 id="controls-title">Control guide</h2>
      <div><dl>{#each site.controls as control}<div class="control"><dt>{control.input}</dt><dd>{control.action}</dd></div>{/each}</dl><p class="control-note">{site.controlNote}</p></div>
    </section>
  </main>
  <footer>
    <div><a class="arcade-link" href={arcade}>Back to Tower Arcade</a><p>Independent fan game inspired by The Tower.<br />Not affiliated with Tech Tree Games.</p></div>
    <a class="creator" href="https://store.techtreegames.com/thetower/" target="_blank" rel="noopener noreferrer" aria-label="Creator Code JDEVO, opens in a new tab"><span>Creator Code</span><strong>JDEVO</strong></a>
  </footer>
</div>

<style>
  :global(*){box-sizing:border-box}
  :global(html){color-scheme:dark;scroll-padding-top:24px}
  :global(body){margin:0;background:#0b1016;color:#f1f4ea;font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:16px;line-height:1.7;-webkit-font-smoothing:antialiased}
  :global(a){color:inherit;text-underline-offset:5px}
  :global(a:focus-visible){outline:2px solid var(--accent,#f1f4ea);outline-offset:5px;border-radius:2px}
  :global(::selection){color:#0b1016;background:#f1f4ea}
  .site{max-width:1248px;padding:0 clamp(20px,5vw,64px);margin:0 auto}
  .skip{position:absolute;left:20px;top:-100px;z-index:2;background:#f1f4ea;color:#0b1016;padding:10px 16px}.skip:focus{top:12px}
  .masthead{display:flex;justify-content:space-between;align-items:center;gap:24px;min-height:96px;border-bottom:1px solid #354038}
  .arcade-link{display:inline-flex;align-items:center;min-height:44px;color:var(--accent);font-weight:650;text-decoration:none}
  nav{display:flex;gap:28px;flex-wrap:wrap}nav a{display:inline-flex;align-items:center;min-height:44px;text-decoration:none;color:#c8d2cb}nav a:hover,.quiet:hover{text-decoration:underline;color:#f1f4ea}
  .hero{display:grid;grid-template-columns:minmax(0,1.7fr) minmax(240px,1fr);gap:clamp(32px,6vw,80px);padding:72px 0 70px;align-items:end}
  h1{font-size:clamp(44px,7.4vw,94px);line-height:1.02;letter-spacing:-.035em;font-weight:700;margin:0;max-width:14ch;text-wrap:balance}
  .alias{font-size:15px;color:#bac7bf;margin:18px 0 0}
  .premise{font-size:clamp(22px,2.5vw,30px);line-height:1.35;font-weight:550;max-width:26ch;margin:28px 0 18px;color:var(--accent)}
  .summary{font-size:18px;line-height:1.7;color:#c8d2cb;max-width:48ch;margin:0}
  .hero-links{display:flex;align-items:center;flex-wrap:wrap;gap:16px 24px;margin-top:32px}.primary{display:inline-flex;align-items:center;min-height:48px;padding:10px 20px;border-radius:6px;background:var(--accent);color:#0b1016;font-weight:700;text-decoration:none}.primary:hover{filter:brightness(1.08)}.quiet{display:inline-flex;align-items:center;min-height:44px;color:#d2dcd5;text-decoration:none}
  .availability{border-top:2px solid var(--accent);padding-top:22px}.genre{margin:0 0 10px;color:var(--accent);font-size:15px;font-weight:600}.availability h2{font-size:26px;margin:0 0 12px;line-height:1.3}.availability p{color:#c8d2cb;margin:0 0 18px}.availability .preview-note{font-size:15px;color:#bac7bf;margin-bottom:0}
  .content-section{display:grid;grid-template-columns:minmax(150px,1fr) minmax(0,2.2fr);gap:64px;border-top:1px solid #354038;padding:48px 0;scroll-margin-top:24px}
  h2{font-size:26px;line-height:1.35;font-weight:650;letter-spacing:-.02em;margin:0}h3{font-size:19px;line-height:1.5;font-weight:650;margin:0 0 8px}
  .prose{max-width:65ch}.prose>p{color:#c8d2cb;margin:0 0 20px}.features{list-style:none;margin:30px 0 0;padding:0}.features li+li{margin-top:22px}.features strong{font-size:18px;color:#f1f4ea}.features p{margin:4px 0 0;color:#bac7bf}
  .steps{padding-left:24px;margin:0;max-width:65ch}.steps li{padding-left:12px}.steps li+li{margin-top:28px}.steps li::marker{color:var(--accent);font-weight:650}.steps p{color:#c8d2cb;margin:0}
  dl{margin:0}.control{display:grid;grid-template-columns:minmax(130px,1fr) minmax(0,2fr);gap:24px;padding:18px 0;border-bottom:1px solid #28332d}.control:first-child{padding-top:0}dt{font-weight:650;color:#f1f4ea}dd{margin:0;color:#c8d2cb}.control-note{font-size:15px;color:#bac7bf;margin:22px 0 0}
  footer{border-top:1px solid #354038;display:flex;justify-content:space-between;align-items:flex-start;gap:32px;padding:32px 0 42px}footer p{color:#bac7bf;font-size:14px;line-height:1.7;margin:8px 0 0}.creator{display:inline-flex;flex-direction:column;justify-content:center;min-height:44px;text-decoration:none;padding:4px 0}.creator span{font-size:13px;line-height:1.3;color:#bac7bf}.creator strong{font-size:19px;line-height:1.5;color:var(--accent)}
  @media(max-width:760px){.hero{grid-template-columns:1fr;padding:42px 0;gap:36px}.availability{max-width:65ch}.content-section{grid-template-columns:1fr;gap:24px;padding:36px 0}.masthead{align-items:flex-start;flex-direction:column;gap:0;padding:16px 0}nav{gap:24px}.hero-links{gap:12px 20px}footer{flex-wrap:wrap}}
  @media(max-width:420px){.control{grid-template-columns:1fr;gap:6px}.summary{font-size:17px}nav{gap:20px}.primary{padding:10px 16px}}
</style>
