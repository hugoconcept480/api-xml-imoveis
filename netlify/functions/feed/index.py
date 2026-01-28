import requests
import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape

def handler(event, context):
    # Pega o hash da URL
    params = event.get('queryStringParameters', {})
    client_hash = params.get('hash')
    client_domain = params.get('domain', 'seusite.com.br')

    if not client_hash:
        return {'statusCode': 400, 'body': 'Hash obrigatorio.'}

    # URL da ConceptSoft
    SOURCE_URL = f"https://xml.imob86.conceptsoft.com.br/Imob86XML/listar/{client_hash}"
    
    try:
        # Timeout de 8s para não travar
        response = requests.get(SOURCE_URL, timeout=8)
        response.encoding = 'utf-8' # Força UTF-8
        
        if response.status_code != 200:
             return {'statusCode': 502, 'body': f'Erro na Origem: {response.status_code}'}

        try:
            root = ET.fromstring(response.content)
        except:
            return {'statusCode': 502, 'body': 'XML invalido.'}
        
        rss_items = []
        xml_header = """<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:g="http://base.google.com/ns/1.0" version="2.0">
<channel>
<title>Feed Imoveis</title>
<description>Catalogo Meta Ads</description>
"""
        
        for imovel in root.findall('imovel'):
            try:
                def get_val(tag, default=""):
                    el = imovel.find(tag)
                    return el.text if el is not None and el.text else default

                id_imov = get_val('idNaImobiliaria')
                if not id_imov: continue 

                titulo = get_val('tituloSite') 
                if not titulo:
                    titulo = f"{get_val('tipoImovel/nome')} em {get_val('bairro/nome')}"

                price = f"{get_val('valor', '0')} BRL"
                link = f"https://{client_domain}/imovel/{id_imov}"

                imgs_xml = ""
                images = imovel.findall('imagens/imagem')
                if images:
                    first = images[0].find('path').text
                    imgs_xml += f"<g:image_link>{first}</g:image_link>"
                    for img in images[1:11]:
                        path = img.find('path').text
                        imgs_xml += f"<g:additional_image_link>{path}</g:additional_image_link>"

                item = f"""
    <item>
        <g:home_listing_id>{id_imov}</g:home_listing_id>
        <title>{escape(titulo)}</title>
        <g:description>{escape(get_val('descricao')[:4900])}</g:description>
        <g:price>{price}</g:price>
        <g:availability>for_sale</g:availability>
        <link>{link}</link>
        {imgs_xml}
        <g:address format="struct">
            <g:addr1>{escape(get_val('endereco'))}</g:addr1>
            <g:city>{escape(get_val('cidade/nome'))}</g:city>
            <g:region>PI</g:region>
            <g:postal_code>{get_val('cep')}</g:postal_code>
            <g:country>BR</g:country>
        </g:address>
        <g:num_beds>{get_val('quartos', '0')}</g:num_beds>
        <g:num_baths>{get_val('banheiros', '0')}</g:num_baths>
        <g:property_type>apartment</g:property_type>
        <g:listing_type>for_sale_by_agent</g:listing_type>
    </item>"""
                rss_items.append(item)
            except:
                continue

        final_xml = xml_header + "".join(rss_items) + "\n</channel>\n</rss>"

        return {
            'statusCode': 200,
            'headers': {
                'Content-Type': 'application/xml; charset=utf-8',
                'Cache-Control': 'public, max-age=3600'
            },
            'body': final_xml
        }

    except Exception as e:
        return {'statusCode': 500, 'body': str(e)}
