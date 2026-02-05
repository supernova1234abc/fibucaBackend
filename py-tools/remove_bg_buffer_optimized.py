#!/usr/bin/env python3
"""
Streaming background removal for buffer/pipe operations
Optimized for low-RAM systems
"""

import sys
import io
import gc
from PIL import Image
from rembg import remove

MAX_DIMENSION = 800
COMPRESSION_QUALITY = 85

def process_stream():
    """Process image from stdin with minimal memory usage"""
    try:
        # Read from stdin in chunks to avoid loading entire file
        input_buffer = io.BytesIO()
        chunk_size = 256 * 1024  # 256KB chunks
        
        while True:
            chunk = sys.stdin.buffer.read(chunk_size)
            if not chunk:
                break
            input_buffer.write(chunk)
        
        input_buffer.seek(0)
        input_data = input_buffer.read()
        input_buffer.close()
        
        # Optimize image first
        img = Image.open(io.BytesIO(input_data))
        
        if img.mode in ('RGBA', 'LA', 'P'):
            img = img.convert('RGB')
        
        # Resize if needed
        if img.width > MAX_DIMENSION or img.height > MAX_DIMENSION:
            img.thumbnail((MAX_DIMENSION, MAX_DIMENSION), Image.Resampling.LANCZOS)
        
        # Save optimized version to temp buffer
        optimized_buffer = io.BytesIO()
        img.save(optimized_buffer, 'JPEG', quality=COMPRESSION_QUALITY, optimize=True)
        optimized_buffer.seek(0)
        optimized_data = optimized_buffer.read()
        optimized_buffer.close()
        
        # Clear original
        del input_data, img
        gc.collect()
        
        # Remove background
        output_data = remove(optimized_data)
        del optimized_data
        gc.collect()
        
        # Process result
        img = Image.open(io.BytesIO(output_data)).convert("RGBA")
        
        # Add background
        bg_color = (239, 246, 255, 255)
        bg = Image.new("RGBA", img.size, bg_color)
        combined = Image.alpha_composite(bg, img)
        
        # Write to stdout as PNG
        output_buffer = io.BytesIO()
        combined.save(output_buffer, format="PNG", optimize=True)
        sys.stdout.buffer.write(output_buffer.getvalue())
        
        return True
        
    except Exception as e:
        print(f"❌ Stream processing failed: {e}", file=sys.stderr)
        return False
    finally:
        gc.collect()

if __name__ == '__main__':
    success = process_stream()
    sys.exit(0 if success else 1)
