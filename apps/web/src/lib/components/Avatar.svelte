<script lang="ts">
  import { api } from '../api.ts';

  interface Props {
    hash: string | null | undefined;
    name: string;
    /** Rendered width in pixels; height follows the 2:3 card portrait ratio. */
    width?: number;
    round?: boolean;
  }
  let { hash, name, width = 44, round = false }: Props = $props();

  const initials = $derived(
    name
      .trim()
      .split(/\s+/)
      .map((w) => Array.from(w)[0] ?? '')
      .slice(0, 2)
      .join('')
      .toUpperCase(),
  );
  const hue = $derived([...name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 7));
</script>

<span
  class="avatar"
  class:round
  style:width="{width}px"
  style:height="{round ? width : Math.round(width * 1.5)}px"
  style:--hue={hue}
>
  {#if hash}
    <img
      src={api.thumbUrl(hash, width > 96 ? 512 : width > 48 ? 256 : 96)}
      alt=""
      loading="lazy"
      decoding="async"
    />
  {:else}
    <span class="initials" aria-hidden="true">{initials}</span>
  {/if}
</span>

<style>
  .avatar {
    display: inline-grid;
    flex: none;
    overflow: hidden;
    border-radius: var(--bt-radius-sm);
    background: oklch(0.42 0.06 var(--hue));
  }
  .avatar.round {
    border-radius: 50%;
  }
  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: top center;
  }
  .initials {
    place-self: center;
    font-size: 0.85rem;
    font-weight: 600;
    color: oklch(0.92 0.03 var(--hue));
  }
</style>
