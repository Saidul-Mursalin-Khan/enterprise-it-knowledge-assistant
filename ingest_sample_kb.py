
from pathlib import Path

from app.core.config import get_settings
from app.services.ingestion import SUPPORTED, load_file, chunk_documents
from app.rag.vectorstore import add_documents


settings = get_settings()
folder = Path(settings.sample_kb_dir)

if not folder.is_dir():
    raise FileNotFoundError(f"Knowledge base directory not found: {folder}")

files = sorted(
    path
    for path in folder.iterdir()
    if path.is_file() and path.suffix.lower() in SUPPORTED
)

skipped = [
    path.name
    for path in folder.iterdir()
    if path.is_file() and path.suffix.lower() not in SUPPORTED
]

if skipped:
    print(f"Skipping unsupported files: {', '.join(skipped)}")

if not files:
    raise ValueError(f"No supported files found in {folder}")

all_docs = []

for path in files:
    print(f"Loading: {path.name}")
    try:
        all_docs.extend(load_file(path))
    except Exception as exc:
        raise RuntimeError(f"Failed to load {path.name}: {exc}") from exc

chunks = chunk_documents(all_docs)

if not chunks:
    raise ValueError("No chunks were generated from the source documents.")

ids = add_documents(chunks)

print(
    f"Indexed {len(files)} files -> "
    f"{len(chunks)} chunks -> "
    f"{len(ids)} Pinecone vectors"
)