import ArrowUpRight from './ArrowUpRight'
import ProjectImages from './ProjectImages'
const formats = { app: 'Web app', taxonomy: 'Classification taxonomy', visual: 'Visual experiment', slides: 'Presentation', video: 'Moving image', writing: 'Short fiction', comic: 'Webcomic', research: 'Research study', live2d: 'Live2D model', experiment: 'Shared AI room', other: 'Concept / invitation' }
const actions = { app: 'Visit Yomi', taxonomy: 'Open the spreadsheet', visual: 'Explore the images', slides: 'Open the presentation', video: 'Watch the project', writing: 'Read the story', comic: 'Read the comic', research: 'Open the study', live2d: 'Meet her live', experiment: 'Visit Nodus', other: 'Open the invitation' }
export default function Dossier({ project, index, phase, mark, authorized, onAnother, ref }) {
  return <article className="project-sheet" ref={ref} tabIndex={-1} inert={phase === 'opening' ? true : undefined} aria-label="Revealed project">
    <div className="dossier-body">
    <div className="sheet-meta"><span>Y / O <b>PERSONAL ARCHIVE</b></span><span>FILE {String(index+1).padStart(3,'0')}</span></div>
    <figure className="dossier-figure"><ProjectImages key={project.id} project={project}/><figcaption><span>01 / A CLOSER LOOK</span><span>{formats[project.type]}</span></figcaption></figure>
    <div className="sheet-copy"><span className="eyebrow">WORKS, EXPERIMENTS & OTHER THINGS</span><h1>{project.name}</h1>
      <details key={project.id} className="field-notes" open><summary><span>From my notebook</span><span className="notes-plus" aria-hidden="true">+</span></summary><p>{project.longDescription}</p></details>
      {project.sourceLink && <p className="project-source"><a href={project.sourceLink} target="_blank" rel="noreferrer">Browse the code on GitHub <ArrowUpRight/></a></p>}<div className="dossier-provenance"><div><span className="provenance-label">{authorized ? (mark.length ? 'RELEASED WITH YOUR MARK' : 'RELEASED FROM THE ARCHIVE') : 'FROM THE COLLECTION'}</span>{mark.length ? <svg className="dossier-signature" viewBox="0 0 300 90" role="img" aria-label="Your drawn mark">{mark.map((stroke,i)=><polyline key={i} points={stroke.map(p=>p.join(',')).join(' ')}/>)}</svg> : <span className="archive-credit">yuri ootani</span>}</div><span className="dossier-seal">{authorized ? 'AUTHORIZED' : 'CATALOGUED'}<small>Y / O — {String(index+1).padStart(3,'0')}</small></span></div>
    </div></div>
    <div className="dossier-actions"><a className="visit" href={project.link} target="_blank" rel="noreferrer"><span>{actions[project.type] || 'View project'}<small>Opens in a new tab</small></span><span aria-hidden="true"><ArrowUpRight/></span></a><button className="another" onClick={onAnother}>Another envelope ↺</button></div>
  </article>
}



