from PIL import Image
import os
import subprocess
import shutil

icon_dir = os.path.dirname(os.path.abspath(__file__))
img = Image.open(os.path.join(icon_dir, 'icon.png')).convert('RGBA')

iconset = os.path.join(icon_dir, 'icon.iconset')
if os.path.exists(iconset):
    shutil.rmtree(iconset)
os.makedirs(iconset)

sizes = [16, 32, 64, 128, 256, 512]
for size in sizes:
    img.resize((size, size), Image.LANCZOS).save(os.path.join(iconset, f'icon_{size}x{size}.png'))
    img.resize((size * 2, size * 2), Image.LANCZOS).save(os.path.join(iconset, f'icon_{size}x{size}@2x.png'))

subprocess.run(['iconutil', '-c', 'icns', iconset, '-o', os.path.join(icon_dir, 'icon.icns')], check=True)
shutil.rmtree(iconset)

ico_sizes = [(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
img.save(os.path.join(icon_dir, 'icon.ico'), format='ICO', sizes=ico_sizes)
print('All icons generated successfully!')
