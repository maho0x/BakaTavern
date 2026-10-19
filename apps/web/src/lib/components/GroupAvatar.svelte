<script lang="ts">
  import type { Group } from '@bakatavern/api-client';

  import { api } from '../api.ts';
  import { library } from '../state/library.svelte.ts';
  import Avatar from './Avatar.svelte';

  interface Props {
    group: Pick<Group, 'avatar' | 'name' | 'members'>;
    /** Rendered width in pixels; height follows the 2:3 portrait ratio unless round. */
    width?: number;
    round?: boolean;
  }
  let { group, width = 44, round = false }: Props = $props();

  // Without a picture of its own a group shows up to four members, like SillyTavern's collage.
  const faces = $derived(
    group.members
      .map((m) => library.character(m.characterId))
      .filter((c) => c !== undefined)
      .slice(0, 4),
  );
  const height = $derived(round ? width : Math.round(width * 1.5));
</script>

{#if group.avatar || faces.length === 0}
  <Avatar hash={group.avatar} name={group.name} {width} {round} />
{:else}
  <span
    class="collage n{faces.length}"
    class:round
    style:width="{width}px"
    style:height="{height}px"
    aria-hidden="true"
  >
    {#each faces as face (face.id)}
      {#if face.avatar}
        <img src={api.thumbUrl(face.avatar, 96)} alt="" loading="lazy" decoding="async" />
      {:else}
        <span class="initial">{Array.from(face.name)[0] ?? ''}</span>
      {/if}
    {/each}
  </span>
{/if}

<style>
  .collage {
    display: inline-grid;
    flex: none;
    gap: 1px;
    overflow: hidden;
    border-radius: var(--bt-radius-sm);
    background: var(--bt-line);
  }
  .collage.round {
    border-radius: 50%;
  }
  .n2 {
    grid-template-columns: 1fr 1fr;
  }
  .n3,
  .n4 {
    grid-template-columns: 1fr 1fr;
    grid-template-rows: 1fr 1fr;
  }
  .n3 > :first-child {
    grid-row: span 2;
  }
  img,
  .initial {
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    object-fit: cover;
    object-position: top center;
  }
  .initial {
    display: grid;
    place-items: center;
    font-size: 0.7rem;
    font-weight: 600;
    background: var(--bt-surface-3);
    color: var(--bt-ink-muted);
  }
</style>
