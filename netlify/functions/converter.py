import requests
import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape

def handler(event, context):
    # Pega os parametros que o netlify.toml enviou
    params = event.get('queryStringParameters', {})
    client_hash = params.get('hash')
    
    # Se quiser passar o dominio do cliente na url: .../HASH?domain=site.com.br
    # Se não passar, usa um genérico
    client_domain = params.get('domain', 'seusite.com.br')

    if not client_hash:
        return {'statusCode': 400, 'body': 'Hash do cliente obrigatorio.'}

    # URL da ConceptSoft
    SOURCE_URL = f"https://xml.imob86.conceptsoft.com.br/Imob86XML/listar/{client_hash}"
    
    try:
        # Baixa o XML original (Timeout de 9s)
        response = requests.get(SOURCE_URL, timeout=9)
        
        if response.status_code != 200:
             return {'statusCode': 502, 'body': f'Erro na ConceptSoft: {response.status_code}'}

        # Tenta ler o XML
        try:
            root = ET.fromstring(response.content)
        except ET.ParseError:
            return {'statusCode': 502, 'body': 'XML da ConceptSoft inválido ou corrompido.'}
        
        rss_items = []
        
        # Cabeçalho Fixo do Meta
        xml_header = """<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:g="http://base.google.com/ns/1.0" version="2.0">
<channel>
<title>Feed Imoveis</title>
<description>Catalogo Otimizado Meta Ads</description>
"""
        
        # Loop pelos imóveis
        for imovel in root.findall('imovel'):
            try:
                def get_val(tag, default=""):
                    el = imovel.find(tag)
                    return el.text if el is not None and el.text else default

                id_imov = get_val('idNaImobiliaria')
                if not id_imov: continue 

                # Monta Titulo
                titulo = get_val('tituloSite') 
                if not titulo:
                    titulo = f"{get_val('tipoImovel/nome')} em {get_val('bairro/nome')}"

                # Monta Preço
                price = f"{get_val('valor', '0')} BRL"
                
                # Monta Link (Dinâmico baseado no dominio)
                link = f"https://{client_domain}/imovel/{id_imov}"

                # Imagens
                imgs_xml = ""
                images = imovel.findall('imagens/imagem')
                if images:
                    # Primeira imagem (obrigatória)
                    first_path = images[0].find('path').text
                    imgs_xml += f"<g:image_link>{first_path}</g:image_link>"
                    # Imagens adicionais (até 10)
                    for img in images[1:11]:
                        path = img.find('path').text
                        imgs_xml += f"<g:additional_image_link>{path}</g:additional_image_link>"

                # Monta o Item XML final
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
                continue # Se der erro em um imóvel, pula para o próximo

        final_xml = xml_header + "".join(rss_items) + "\n</channel>\n</rss>"

        return {
            'statusCode': 200,
            'headers': {
                'Content-Type': 'application/xml; charset=utf-8',
                # Cache de 1 hora no Netlify
                'Cache-Control': 'public, max-age=3600, s-maxage=3600'
            },
            'body': final_xml
        }

    except Exception as e:
        return {'statusCode': 500, 'body': f"Erro interno no servidor: {str(e)}"}
