#!/usr/bin/env python3
import sys
import io
from rembg import remove
from PIL import Image

def main():
    try:
        # 1️⃣ Read raw image bytes from stdin
        input_bytes = sys.stdin.buffer.read()

        # 2️⃣ Open image from bytes
        input_image = Image.open(io.BytesIO(input_bytes)).convert("RGBA")

        # 3️⃣ Remove background
        output_image = remove(input_image)

        # 4️⃣ Save output image to bytes buffer
        output_buffer = io.BytesIO()
        output_image.save(output_buffer, format="PNG")
        output_bytes = output_buffer.getvalue()

        # 5️⃣ Write bytes to stdout
        sys.stdout.buffer.write(output_bytes)
        sys.stdout.buffer.flush()

    except Exception as e:
        # Print error to stderr so Node.js can catch it
        print(f"❌ Python error: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
